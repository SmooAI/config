"""SMOODEV-1526 — ESO manifest generator parity tests (Python)."""

from __future__ import annotations

import pytest
from smooai_config.eso_manifests import (
    BootstrapSecretRef,
    ExternalSecretOptions,
    SecretMapping,
    build_cluster_secret_store,
    build_external_secret,
    resolve_secret_mapping,
)
from smooai_config.utils import SmooaiConfigError


def test_cluster_secret_store_bakes_org_and_env():
    store = build_cluster_secret_store(api_url="https://api.smoo.ai", org_id="org-123", environment="production")
    url = store["spec"]["provider"]["webhook"]["url"]
    assert url == "https://api.smoo.ai/organizations/org-123/config/values/{{ .remoteRef.key }}?environment=production"
    assert "config.smoo.ai" not in url
    assert store["spec"]["provider"]["webhook"]["result"]["jsonPath"] == "$.value"


def test_cluster_secret_store_defaults_and_encoding():
    store = build_cluster_secret_store(api_url="https://api.smoo.ai///", org_id="o", environment="pre prod")
    url = store["spec"]["provider"]["webhook"]["url"]
    assert url.startswith("https://api.smoo.ai/organizations")
    assert "environment=pre%20prod" in url
    ref = store["spec"]["provider"]["webhook"]["secrets"][0]["secretRef"]
    assert ref == {"name": "smooai-config-bootstrap", "namespace": "external-secrets", "key": "bearer-token"}


def test_cluster_secret_store_overrides():
    store = build_cluster_secret_store(
        api_url="https://api.smoo.ai",
        org_id="o",
        environment="production",
        name="smooai-config-prod",
        bootstrap_secret=BootstrapSecretRef(name="s", namespace="ns", key="k"),
    )
    assert store["metadata"]["name"] == "smooai-config-prod"
    assert store["spec"]["provider"]["webhook"]["secrets"][0]["secretRef"] == {"name": "s", "namespace": "ns", "key": "k"}


def test_cluster_secret_store_required_fields():
    with pytest.raises(SmooaiConfigError):
        build_cluster_secret_store(api_url="", org_id="o", environment="e")
    with pytest.raises(SmooaiConfigError):
        build_cluster_secret_store(api_url="u", org_id="", environment="e")
    with pytest.raises(SmooaiConfigError):
        build_cluster_secret_store(api_url="u", org_id="o", environment="")


def test_resolve_secret_mapping():
    assert resolve_secret_mapping("mimoApiKey").env_var == "MIMO_API_KEY"
    m = resolve_secret_mapping(SecretMapping(config_key="alibabaModelStudioApiKey", env_var="DASHSCOPE_API_KEY"))
    assert m.env_var == "DASHSCOPE_API_KEY"


def test_build_external_secret_maps_keys():
    es = build_external_secret(
        ExternalSecretOptions(
            name="litellm-config",
            namespace="smooai-litellm",
            secrets=["mimoApiKey", SecretMapping(config_key="alibabaModelStudioApiKey", env_var="DASHSCOPE_API_KEY")],
        )
    )
    assert es["spec"]["data"] == [
        {"secretKey": "MIMO_API_KEY", "remoteRef": {"key": "mimoApiKey"}},
        {"secretKey": "DASHSCOPE_API_KEY", "remoteRef": {"key": "alibabaModelStudioApiKey"}},
    ]
    assert es["spec"]["target"]["name"] == "litellm-config"
    assert es["spec"]["secretStoreRef"] == {"name": "smooai-config", "kind": "ClusterSecretStore"}


def test_build_external_secret_distinct_target():
    es = build_external_secret(
        ExternalSecretOptions(name="litellm-config-eso", namespace="smooai-litellm", secrets=["mimoApiKey"], target_secret_name="litellm-config-eso")
    )
    assert es["spec"]["target"]["name"] == "litellm-config-eso"


def test_build_external_secret_duplicate_env_var():
    with pytest.raises(SmooaiConfigError, match="duplicate env-var"):
        build_external_secret(
            ExternalSecretOptions(
                name="x",
                namespace="ns",
                secrets=["mimoApiKey", SecretMapping(config_key="somethingElse", env_var="MIMO_API_KEY")],
            )
        )


def test_build_external_secret_required_fields():
    with pytest.raises(SmooaiConfigError):
        build_external_secret(ExternalSecretOptions(name="", namespace="ns", secrets=["k"]))
    with pytest.raises(SmooaiConfigError):
        build_external_secret(ExternalSecretOptions(name="n", namespace="", secrets=["k"]))
    with pytest.raises(SmooaiConfigError):
        build_external_secret(ExternalSecretOptions(name="n", namespace="ns", secrets=[]))
