"""ESO (ExternalSecrets Operator) manifest generator — Python parity port of the
TypeScript ``src/eso-manifests`` (SMOODEV-1526, epic SMOODEV-1522).

Emits the two ESO resources that let a Kubernetes workload pull its secrets from
the @smooai/config HTTP API (api.smoo.ai) instead of having them baked at deploy
time:

1. :func:`build_cluster_secret_store` — a ``ClusterSecretStore`` whose webhook
   provider points at the real config-values endpoint (org + env baked into the
   URL, bearer from the bootstrap Secret the eso-refresher keeps fresh).
2. :func:`build_external_secret` — a per-workload ``ExternalSecret`` mapping
   secret-tier config keys to env-var names (UPPER_SNAKE_CASE by default,
   overridable).

Returns plain ``dict`` structures (cdk8s / kubectl / YAML all accept them). No
cluster or network access.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

from smooai_config.utils import SmooaiConfigError, camel_to_upper_snake

ESO_DEFAULT_CLUSTER_SECRET_STORE_NAME = "smooai-config"
ESO_DEFAULT_BOOTSTRAP_SECRET_NAME = "smooai-config-bootstrap"
ESO_DEFAULT_BOOTSTRAP_SECRET_NAMESPACE = "external-secrets"
ESO_DEFAULT_BOOTSTRAP_SECRET_KEY = "bearer-token"
ESO_DEFAULT_REFRESH_INTERVAL = "1h"
ESO_API_VERSION = "external-secrets.io/v1beta1"


@dataclass
class BootstrapSecretRef:
    """Reference to the k8s Secret + key holding the ESO bearer token."""

    name: str = ESO_DEFAULT_BOOTSTRAP_SECRET_NAME
    namespace: str = ESO_DEFAULT_BOOTSTRAP_SECRET_NAMESPACE
    key: str = ESO_DEFAULT_BOOTSTRAP_SECRET_KEY


def build_cluster_secret_store(
    *,
    api_url: str,
    org_id: str,
    environment: str,
    name: str = ESO_DEFAULT_CLUSTER_SECRET_STORE_NAME,
    bootstrap_secret: BootstrapSecretRef | None = None,
) -> dict[str, Any]:
    """Build a ``ClusterSecretStore`` backed by the @smooai/config webhook provider.

    ``org_id`` + ``environment`` are baked into the URL because ESO's webhook only
    templates ``{{ .remoteRef.key }}`` per-secret — so a store is scoped to one
    (org, env) pair. Raises :class:`ConfigError` on missing required fields.
    """
    if not api_url:
        raise SmooaiConfigError("build_cluster_secret_store: api_url is required")
    if not org_id:
        raise SmooaiConfigError("build_cluster_secret_store: org_id is required")
    if not environment:
        raise SmooaiConfigError("build_cluster_secret_store: environment is required")

    ref = bootstrap_secret or BootstrapSecretRef()
    base = api_url.rstrip("/")
    url = f"{base}/organizations/{org_id}/config/values/{{{{ .remoteRef.key }}}}?environment={quote(environment, safe='')}"

    return {
        "apiVersion": ESO_API_VERSION,
        "kind": "ClusterSecretStore",
        "metadata": {"name": name},
        "spec": {
            "provider": {
                "webhook": {
                    "url": url,
                    "headers": {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer {{ .auth.token }}",
                    },
                    "result": {"jsonPath": "$.value"},
                    "secrets": [
                        {
                            "name": "auth",
                            "secretRef": {
                                "name": ref.name,
                                "namespace": ref.namespace,
                                "key": ref.key,
                            },
                        }
                    ],
                }
            }
        },
    }


@dataclass
class SecretMapping:
    """A config key → the env-var name the workload reads.

    ``env_var`` defaults to ``UPPER_SNAKE_CASE(config_key)``.
    """

    config_key: str
    env_var: str | None = None


def resolve_secret_mapping(mapping: SecretMapping | str) -> SecretMapping:
    """Normalize a mapping, defaulting ``env_var`` to the snakecase of ``config_key``."""
    m = SecretMapping(config_key=mapping) if isinstance(mapping, str) else mapping
    if not m.config_key:
        raise SmooaiConfigError("resolve_secret_mapping: config_key is required")
    return SecretMapping(config_key=m.config_key, env_var=m.env_var or camel_to_upper_snake(m.config_key))


@dataclass
class ExternalSecretOptions:
    name: str
    namespace: str
    secrets: list[SecretMapping | str]
    target_secret_name: str | None = None
    cluster_secret_store_name: str = ESO_DEFAULT_CLUSTER_SECRET_STORE_NAME
    refresh_interval: str = ESO_DEFAULT_REFRESH_INTERVAL
    labels: dict[str, str] = field(default_factory=dict)


def build_external_secret(opts: ExternalSecretOptions) -> dict[str, Any]:
    """Build a per-workload ``ExternalSecret``.

    Each entry becomes a data mapping of ``secretKey`` (the env-var name in the
    synced Secret) ← ``remoteRef.key`` (the @smooai/config key). Raises
    :class:`ConfigError` on missing required fields or duplicate env-var names.
    """
    if not opts.name:
        raise SmooaiConfigError("build_external_secret: name is required")
    if not opts.namespace:
        raise SmooaiConfigError("build_external_secret: namespace is required")
    if not opts.secrets:
        raise SmooaiConfigError("build_external_secret: at least one secret mapping is required")

    data: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in opts.secrets:
        resolved = resolve_secret_mapping(entry)
        assert resolved.env_var is not None  # resolve_secret_mapping always sets it
        if resolved.env_var in seen:
            raise SmooaiConfigError(f"build_external_secret: duplicate env-var name: {resolved.env_var}")
        seen.add(resolved.env_var)
        data.append({"secretKey": resolved.env_var, "remoteRef": {"key": resolved.config_key}})

    metadata: dict[str, Any] = {"name": opts.name, "namespace": opts.namespace}
    if opts.labels:
        metadata["labels"] = opts.labels

    return {
        "apiVersion": ESO_API_VERSION,
        "kind": "ExternalSecret",
        "metadata": metadata,
        "spec": {
            "refreshInterval": opts.refresh_interval,
            "secretStoreRef": {"name": opts.cluster_secret_store_name, "kind": "ClusterSecretStore"},
            "target": {"name": opts.target_secret_name or opts.name, "creationPolicy": "Owner"},
            "data": data,
        },
    }
