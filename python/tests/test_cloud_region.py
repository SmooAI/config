"""Tests for cloud provider/region detection."""

from smooai_config.cloud_region import CloudRegionResult, get_cloud_region


class TestGetCloudRegion:
    def test_custom_override_both(self) -> None:
        env = {"SMOOAI_CONFIG_CLOUD_PROVIDER": "custom-cloud", "SMOOAI_CONFIG_CLOUD_REGION": "custom-region-1"}
        result = get_cloud_region(env)
        assert result == CloudRegionResult(provider="custom-cloud", region="custom-region-1")

    def test_custom_provider_only(self) -> None:
        env = {"SMOOAI_CONFIG_CLOUD_PROVIDER": "my-cloud"}
        result = get_cloud_region(env)
        assert result == CloudRegionResult(provider="my-cloud", region="unknown")

    def test_custom_region_only(self) -> None:
        env = {"SMOOAI_CONFIG_CLOUD_REGION": "my-region"}
        result = get_cloud_region(env)
        assert result == CloudRegionResult(provider="unknown", region="my-region")

    def test_aws_region(self) -> None:
        env = {"AWS_REGION": "us-east-1"}
        result = get_cloud_region(env)
        assert result == CloudRegionResult(provider="aws", region="us-east-1")

    def test_aws_default_region_fallback(self) -> None:
        env = {"AWS_DEFAULT_REGION": "eu-west-1"}
        result = get_cloud_region(env)
        assert result == CloudRegionResult(provider="aws", region="eu-west-1")

    def test_aws_region_takes_priority_over_default(self) -> None:
        env = {"AWS_REGION": "us-west-2", "AWS_DEFAULT_REGION": "eu-west-1"}
        result = get_cloud_region(env)
        assert result == CloudRegionResult(provider="aws", region="us-west-2")

    def test_azure_region(self) -> None:
        env = {"AZURE_REGION": "eastus"}
        result = get_cloud_region(env)
        assert result == CloudRegionResult(provider="azure", region="eastus")

    def test_azure_location_fallback(self) -> None:
        env = {"AZURE_LOCATION": "westeurope"}
        result = get_cloud_region(env)
        assert result == CloudRegionResult(provider="azure", region="westeurope")

    def test_gcp_region(self) -> None:
        env = {"GOOGLE_CLOUD_REGION": "us-central1"}
        result = get_cloud_region(env)
        assert result == CloudRegionResult(provider="gcp", region="us-central1")

    def test_gcp_cloudsdk_fallback(self) -> None:
        env = {"CLOUDSDK_COMPUTE_REGION": "europe-west1"}
        result = get_cloud_region(env)
        assert result == CloudRegionResult(provider="gcp", region="europe-west1")

    def test_empty_env_returns_unknown(self) -> None:
        result = get_cloud_region({})
        assert result == CloudRegionResult(provider="unknown", region="unknown")

    def test_custom_overrides_aws(self) -> None:
        env = {
            "SMOOAI_CONFIG_CLOUD_PROVIDER": "custom",
            "SMOOAI_CONFIG_CLOUD_REGION": "custom-1",
            "AWS_REGION": "us-east-1",
        }
        result = get_cloud_region(env)
        assert result == CloudRegionResult(provider="custom", region="custom-1")

    def test_aws_takes_priority_over_azure(self) -> None:
        env = {"AWS_REGION": "us-east-1", "AZURE_REGION": "eastus"}
        result = get_cloud_region(env)
        assert result == CloudRegionResult(provider="aws", region="us-east-1")

    def test_azure_takes_priority_over_gcp(self) -> None:
        env = {"AZURE_REGION": "eastus", "GOOGLE_CLOUD_REGION": "us-central1"}
        result = get_cloud_region(env)
        assert result == CloudRegionResult(provider="azure", region="eastus")
