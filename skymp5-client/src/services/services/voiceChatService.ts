import { logTrace, logError } from "../../logging";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { MsgType } from "../../messages";
import { getViewFromStorage } from "../../view/worldViewMisc";

// Voice chat modes matching C++ VoiceChat::VoiceMode enum
const VOICE_MODE_PROXIMITY = 0;
const VOICE_MODE_GLOBAL = 1;

// Default push-to-talk key (V = DxScanCode 47)
const DEFAULT_PTT_KEY = 47;

// Key to cycle voice mode whisper -> local -> yell (B = DxScanCode 48)
const VOICE_MODE_KEY = 48;

// Proximity range presets the player cycles between. The names match the new UI
// HUD (sky-mp-ui data/voiceModes.ts) and PROTOCOL `voiceModeChanged`.
type VoiceModeName = "whisper" | "local" | "yell";
const VOICE_MODE_ORDER: VoiceModeName[] = ["whisper", "local", "yell"];
const DEFAULT_RANGES: Record<VoiceModeName, number> = { whisper: 600, local: 4000, yell: 12000 };

// Minimum interval between reconnect attempts (ms)
const RECONNECT_COOLDOWN_MS = 5000;

export class VoiceChatService extends ClientListener {
  private voiceChatAvailable = false;
  private pttKey = DEFAULT_PTT_KEY;
  private pttPressed = false;
  private lastReconnectRequestTime = 0;
  // Maps LiveKit identity -> server-side actor refrId
  private voiceParticipantMap = new Map<string, number>();

  // Voice-mode cycling (whisper/local/yell) — proximity range presets + HUD sync.
  private ranges: Record<VoiceModeName, number> = { ...DEFAULT_RANGES };
  private modeIndex = VOICE_MODE_ORDER.indexOf("local");
  private modeKeyPressed = false;

  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    // Check if voice chat functions exist on the native plugin
    this.voiceChatAvailable = typeof this.sp.mpClientPlugin?.initVoiceChat === "function";
    if (!this.voiceChatAvailable) {
      logTrace(this, "Voice chat not available (MpClientPlugin built without SKYMP_VOICE_CHAT_ENABLED)");
      return;
    }

    this.controller.on("tick", () => this.onTick());
    this.controller.on("update", () => {
      try { this.handlePTT(); }
      catch (e) { logError(this, "handlePTT error: " + String(e)); }
      try { this.handleModeCycle(); }
      catch (e) { logError(this, "handleModeCycle error: " + String(e)); }
      try { this.updateSpatialPositions(); }
      catch (e) { logError(this, "updateSpatialPositions error: " + String(e)); }
    });
    this.controller.emitter.on("connectionDisconnect", () => this.onDisconnected());

    // Voice config arrives via customPacket AFTER the server creates
    // the player's actor (onPlayerLoaded server-side). We do NOT init
    // voice on connectionAccepted — only when we receive the config,
    // which the server sends only after the actor exists in the world.
    this.controller.emitter.on("customPacketMessage", (e) => {
      try {
        const parsed = JSON.parse(e.message?.contentJsonDump || "{}");
        if (parsed.customPacketType === "voiceConfig") {
          this.onVoiceConfig(parsed);
        } else if (parsed.customPacketType === "voiceParticipantMap") {
          this.onVoiceParticipantMap(parsed);
        }
      } catch (_) { /* ignore parse errors from other packets */ }
    });

    logTrace(this, "Voice chat service initialized");
  }

  private onDisconnected() {
    this.shutdownVoice();
  }

  private onVoiceConfig(config: {
    customPacketType: string;
    livekitUrl: string;
    token: string;
    sampleRate?: number;
    numChannels?: number;
    pttKey?: number;
    voiceMode?: number;
    inputGain?: number;
    outputVolume?: number;
    voiceRange?: number;
    rangeWhisper?: number;
    rangeLocal?: number;
    rangeYell?: number;
    noiseGateEnabled?: boolean;
    noiseGateThreshold?: number;
    normalizationEnabled?: boolean;
    normalizationTarget?: number;
  }) {
    if (!this.voiceChatAvailable) return;

    logTrace(this, `Received voice config: LiveKit URL=${config.livekitUrl}`);

    // Shutdown existing voice if any
    this.shutdownVoice();

    // Configure PTT key
    if (config.pttKey !== undefined) {
      this.pttKey = config.pttKey;
    }

    // Initialize voice chat
    const sampleRate = config.sampleRate || 48000;
    const numChannels = config.numChannels || 1;

    const success = this.sp.mpClientPlugin.initVoiceChat!(
      config.livekitUrl, config.token, sampleRate, numChannels
    );

    if (!success) {
      logError(this, "Failed to initialize voice chat");
      return;
    }

    logTrace(this, "Voice chat initialized successfully");

    // Apply settings
    if (config.voiceMode !== undefined) {
      this.sp.mpClientPlugin.setVoiceMode!(config.voiceMode);
    }
    if (config.inputGain !== undefined) {
      this.sp.mpClientPlugin.setVoiceInputGain!(config.inputGain);
    }
    if (config.outputVolume !== undefined) {
      this.sp.mpClientPlugin.setVoiceOutputVolume!(config.outputVolume);
    }
    if (config.voiceRange !== undefined && this.sp.mpClientPlugin.setVoiceRange) {
      this.sp.mpClientPlugin.setVoiceRange(config.voiceRange);
    }

    // Mic post-processing: noise gate
    if (config.noiseGateEnabled !== undefined && this.sp.mpClientPlugin.setVoiceNoiseGateEnabled) {
      this.sp.mpClientPlugin.setVoiceNoiseGateEnabled(config.noiseGateEnabled);
    }
    if (config.noiseGateThreshold !== undefined && this.sp.mpClientPlugin.setVoiceNoiseGateThreshold) {
      this.sp.mpClientPlugin.setVoiceNoiseGateThreshold(config.noiseGateThreshold);
    }

    // Mic post-processing: volume normalization (AGC)
    if (config.normalizationEnabled !== undefined && this.sp.mpClientPlugin.setVoiceNormalizationEnabled) {
      this.sp.mpClientPlugin.setVoiceNormalizationEnabled(config.normalizationEnabled);
    }
    if (config.normalizationTarget !== undefined && this.sp.mpClientPlugin.setVoiceNormalizationTarget) {
      this.sp.mpClientPlugin.setVoiceNormalizationTarget(config.normalizationTarget);
    }

    // Pick up whisper/local/yell range presets (fall back to defaults), then
    // apply the initial mode (local) and sync the HUD voice indicator.
    if (typeof config.rangeWhisper === "number") this.ranges.whisper = config.rangeWhisper;
    if (typeof config.rangeLocal === "number") this.ranges.local = config.rangeLocal;
    else if (typeof config.voiceRange === "number") this.ranges.local = config.voiceRange;
    if (typeof config.rangeYell === "number") this.ranges.yell = config.rangeYell;
    this.modeIndex = VOICE_MODE_ORDER.indexOf("local");
    this.applyVoiceMode();
  }

  private onVoiceParticipantMap(data: {
    customPacketType: string;
    participants: Record<string, number>;
  }) {
    this.voiceParticipantMap.clear();
    if (data.participants) {
      const keys = Object.keys(data.participants);
      for (let i = 0; i < keys.length; i++) {
        this.voiceParticipantMap.set(keys[i], data.participants[keys[i]]);
      }
    }
  }

  private onTick() {
    if (!this.voiceChatAvailable) return;

    // Only process voice if initialized
    if (!this.sp.mpClientPlugin.isVoiceChatInitialized?.()) return;

    // Tick voice chat (processes LiveKit events, registers new participants)
    this.sp.mpClientPlugin.tickVoiceChat!();

    // Check if the LiveKit connection was lost and we need a fresh token.
    // This handles the case where LiveKit's built-in reconnect failed
    // (e.g. network was down for > 30s or token expired).
    if (this.sp.mpClientPlugin.needsVoiceReconnect?.()) {
      const now = Date.now();
      if (now - this.lastReconnectRequestTime >= RECONNECT_COOLDOWN_MS) {
        this.lastReconnectRequestTime = now;
        logTrace(this, "Voice disconnected — requesting fresh token from game server");

        // Shut down the dead voice session
        this.shutdownVoice();

        // Request a new voiceConfig by sending a custom packet to the server.
        // The server will generate a new JWT and send it back via CustomPacket.
        this.controller.emitter.emit("sendMessage", {
          message: {
            t: MsgType.CustomPacket,
            contentJsonDump: JSON.stringify({ customPacketType: "voiceReconnectRequest" })
          },
          reliability: "reliable"
        });
      }
    }

  }

  private updateSpatialPositions() {
    if (!this.sp.mpClientPlugin.setVoiceListenerPosition) return;
    if (!this.sp.mpClientPlugin.setVoiceParticipantPosition) return;

    // Update listener (local player) position and facing direction
    try {
      const player = this.sp.Game.getPlayer();
      if (player) {
        const px = player.getPositionX();
        const py = player.getPositionY();
        const pz = player.getPositionZ();
        const angleZ = player.getAngleZ() * (Math.PI / 180.0);
        const dirX = Math.sin(angleZ);
        const dirY = Math.cos(angleZ);
        this.sp.mpClientPlugin.setVoiceListenerPosition!(px, py, pz, dirX, dirY, 0);
      } else {
        logTrace(this, "setVoiceListenerPosition skipped: player is null");
      }
    } catch (e: any) {
      logTrace(this, `setVoiceListenerPosition error: ${e?.message || e}`);
    }

    // Update positions for each remote participant using their in-game actor
    const view = getViewFromStorage();
    if (!view) return;

    this.voiceParticipantMap.forEach((serverRefrId, identity) => {
      // Only server-assigned 0xff... refs can be looked up
      if (serverRefrId < 0xff000000) return;

      let localRefrId: number;
      try {
        localRefrId = view.getLocalRefrId(serverRefrId);
      } catch (_) {
        return;
      }
      if (!localRefrId || localRefrId <= 0) return;

      const refr = this.sp.ObjectReference.from(this.sp.Game.getFormEx(localRefrId));
      if (!refr) return;

      const x = refr.getPositionX();
      const y = refr.getPositionY();
      const z = refr.getPositionZ();
      this.sp.mpClientPlugin.setVoiceParticipantPosition!(identity, x, y, z);
    });

  }

  private handlePTT() {
    if (!this.voiceChatAvailable) return;
    if (!this.sp.mpClientPlugin.isVoiceChatInitialized?.()) return;

    let keyPressed: boolean;
    try {
      keyPressed = this.sp.Input.isKeyPressed(this.pttKey);
    } catch (_) {
      return;
    }

    if (keyPressed && !this.pttPressed) {
      // Key just pressed — start talking
      this.pttPressed = true;
      logTrace(this, "PTT pressed — start talking");
      this.sp.mpClientPlugin.startTalking!();
      this.dispatchBrowser("skymp5-client:startTalking");
    } else if (!keyPressed && this.pttPressed) {
      // Key just released — stop talking
      this.pttPressed = false;
      logTrace(this, "PTT released — stop talking");
      this.sp.mpClientPlugin.stopTalking!();
      this.dispatchBrowser("skymp5-client:stopTalking");
    }
  }

  // Cycle whisper -> local -> yell on a key edge; apply the range preset and
  // tell the HUD via `skymp5-client:voiceModeChanged`.
  private handleModeCycle() {
    if (!this.voiceChatAvailable) return;
    if (!this.sp.mpClientPlugin.isVoiceChatInitialized?.()) return;

    let down: boolean;
    try {
      down = this.sp.Input.isKeyPressed(VOICE_MODE_KEY);
    } catch (_) {
      return;
    }
    if (down && !this.modeKeyPressed) {
      this.modeKeyPressed = true;
      this.modeIndex = (this.modeIndex + 1) % VOICE_MODE_ORDER.length;
      this.applyVoiceMode();
    } else if (!down && this.modeKeyPressed) {
      this.modeKeyPressed = false;
    }
  }

  // Apply the current mode's range to the native plugin and notify the HUD.
  private applyVoiceMode() {
    const name = VOICE_MODE_ORDER[this.modeIndex];
    const range = this.ranges[name];
    if (this.sp.mpClientPlugin.setVoiceRange) {
      try { this.sp.mpClientPlugin.setVoiceRange(range); }
      catch (e) { logTrace(this, `setVoiceRange error: ${String(e)}`); }
    }
    logTrace(this, `Voice mode -> ${name} (range ${range})`);
    this.dispatchBrowser("skymp5-client:voiceModeChanged", { name });
  }

  // Dispatch a CustomEvent into the CEF browser UI (same pattern as browserService).
  private dispatchBrowser(eventName: string, detail?: unknown) {
    try {
      const payload = detail === undefined ? "{}" : JSON.stringify({ detail });
      this.sp.browser.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('${eventName}', ${payload}))`
      );
    } catch (e) {
      logTrace(this, `dispatchBrowser('${eventName}') error: ${String(e)}`);
    }
  }

  private shutdownVoice() {
    if (!this.voiceChatAvailable) return;

    if (this.sp.mpClientPlugin.isVoiceChatInitialized?.()) {
      this.sp.mpClientPlugin.shutdownVoiceChat!();
      this.pttPressed = false;
      logTrace(this, "Voice chat shut down");
    }
  }
}
