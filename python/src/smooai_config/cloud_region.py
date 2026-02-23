"""Cloud provider and region detection from environment variables."""

import os
from dataclasses import dataclass


@dataclass
class CloudRegionResult:
    """Result of cloud provider/region detection."""

    provider: str
    region: str


def get_cloud_region(env: dict[str, str] | None = None) -> CloudRegionResult:
    """Detect cloud provider and region from environment variables.

    Detection order:
    1. SMOOAI_CONFIG_CLOUD_REGION / SMOOAI_CONFIG_CLOUD_PROVIDER (custom override)
    2. AWS_REGION / AWS_DEFAULT_REGION
    3. AZURE_REGION / AZURE_LOCATION
    4. GOOGLE_CLOUD_REGION / CLOUDSDK_COMPUTE_REGION
    5. Default: unknown/unknown

    Args:
        env: Environment variable dict. If None, uses os.environ.
    """
    if env is None:
        env = dict(os.environ)

    # 1. Custom override
    if env.get("SMOOAI_CONFIG_CLOUD_REGION") or env.get("SMOOAI_CONFIG_CLOUD_PROVIDER"):
        return CloudRegionResult(
            provider=env.get("SMOOAI_CONFIG_CLOUD_PROVIDER", "unknown"),
            region=env.get("SMOOAI_CONFIG_CLOUD_REGION", "unknown"),
        )

    # 2. AWS
    aws_region = env.get("AWS_REGION") or env.get("AWS_DEFAULT_REGION")
    if aws_region:
        return CloudRegionResult(provider="aws", region=aws_region)

    # 3. Azure
    azure_region = env.get("AZURE_REGION") or env.get("AZURE_LOCATION")
    if azure_region:
        return CloudRegionResult(provider="azure", region=azure_region)

    # 4. GCP
    gcp_region = env.get("GOOGLE_CLOUD_REGION") or env.get("CLOUDSDK_COMPUTE_REGION")
    if gcp_region:
        return CloudRegionResult(provider="gcp", region=gcp_region)

    # 5. Default
    return CloudRegionResult(provider="unknown", region="unknown")
