#pragma once
#include "Config.h"
#include "NetworkingInterface.h"
#include "RakNet.h"
#include <cstdlib>
#include <memory>
#include <vector>

namespace prometheus {
class Registry;
}

class IdManager;

namespace Networking {

std::shared_ptr<IClient> CreateClient(const char* serverIp,
                                      unsigned short serverPort, int timeoutMs,
                                      const char* password);

constexpr int kDefaultTimeoutTimeMs = 60000;

std::shared_ptr<IServer> CreateServer(
  const char* listenAddress, unsigned short port,
  unsigned short maxConnections, const char* password,
  std::shared_ptr<prometheus::Registry> promRegistry,
  int timeoutTimeMs = kDefaultTimeoutTimeMs);

void HandlePacketClientside(Networking::IClient::OnPacket onPacket,
                            void* state, Packet* packet);

void HandlePacketServerside(Networking::IServer::OnPacket onPacket,
                            void* state, Packet* packet, IdManager& idManager);
}
