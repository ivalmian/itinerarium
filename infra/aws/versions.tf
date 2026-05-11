terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# CloudFront is a global service but its API lives in us-east-1, so we pin
# the provider there. The S3 bucket can live in any region — we use the
# same region for simplicity since it's a static asset bucket and there's
# no cross-region cost concern.
provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project    = "itinerarium"
      ManagedBy  = "terraform"
      Repository = "github.com/${var.github_repository}"
    }
  }
}
