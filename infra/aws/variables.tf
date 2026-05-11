variable "region" {
  type        = string
  description = "AWS region for the S3 bucket. CloudFront is global so this only matters for the bucket."
  default     = "us-east-1"
}

variable "bucket_name" {
  type        = string
  description = "S3 bucket name for the built site. Must be globally unique across AWS."
  default     = "itinerarium-site"
}

variable "github_repository" {
  type        = string
  description = "GitHub repo allowed to assume the deploy role via OIDC. Format: owner/repo."
  default     = "ivalmian/itinerarium"
}

variable "github_branches" {
  type        = list(string)
  description = "Branches allowed to deploy. Wildcard `*` allows any branch; tighten if you only want main."
  default     = ["main"]
}

variable "create_github_oidc_provider" {
  type        = bool
  description = "Whether to create the GitHub Actions OIDC provider. Only one per AWS account is allowed — set to false if your account already has one (a previous project, for example)."
  default     = true
}
