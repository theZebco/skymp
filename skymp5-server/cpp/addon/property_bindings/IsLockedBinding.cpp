#include "IsLockedBinding.h"

Napi::Value IsLockedBinding::Get(Napi::Env env, ScampServer& scampServer,
                                 uint32_t formId)
{
  auto& partOne = scampServer.GetPartOne();

  auto& refr = partOne->worldState.GetFormAt<MpObjectReference>(formId);
  return Napi::Boolean::New(env, refr.IsLocked());
}

void IsLockedBinding::Set(Napi::Env env, ScampServer& scampServer,
                          uint32_t formId, Napi::Value newValue)
{
  auto& partOne = scampServer.GetPartOne();

  auto& refr = partOne->worldState.GetFormAt<MpObjectReference>(formId);
  refr.SetLocked(newValue.As<Napi::Boolean>().Value());
}
