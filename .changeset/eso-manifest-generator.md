---
'@smooai/config': minor
---

SMOODEV-1524: Add an ESO manifest generator (`@smooai/config/eso-manifests`). `buildClusterSecretStore()` emits a `ClusterSecretStore` whose webhook provider points at the real `api.smoo.ai` config-values endpoint (org + environment baked in, bearer from the bootstrap Secret the eso-refresher keeps fresh), and `buildExternalSecret()` emits a per-workload `ExternalSecret` mapping secret-tier config keys to env-var names (`UPPER_SNAKE_CASE` by default, with per-key overrides like `DASHSCOPE_API_KEY` ← `alibabaModelStudioApiKey`). Replaces the hand-maintained ESO YAML and makes ESO sync a first-class output of the config system. Epic SMOODEV-1522.
