# GitHub Actions ↔ AWS via OIDC: no long-lived AWS keys in GitHub secrets.
# The workflow uses `aws-actions/configure-aws-credentials@v4` which exchanges
# a GitHub-signed OIDC token for short-lived AWS credentials.

# Account-level OIDC provider. There can be only ONE per AWS account at this
# URL — if your account already has it (e.g. set up for a previous project),
# flip `create_github_oidc_provider = false` in your tfvars or import the
# existing one (`terraform import aws_iam_openid_connect_provider.github
# arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`).
resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_github_oidc_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  # AWS now derives thumbprints automatically for github.com; this value is
  # the historical published thumbprint and is still accepted. Updating it
  # if it ever rotates only requires a `terraform apply`.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

# Look up the OIDC provider whether we created it just now or it already
# existed in the account. Locals consolidate the arn.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
  depends_on = [
    aws_iam_openid_connect_provider.github,
  ]
}

locals {
  oidc_provider_arn = data.aws_iam_openid_connect_provider.github.arn
  # Build a list of `repo:owner/repo:ref:refs/heads/<branch>` subs.
  github_sub_patterns = [
    for branch in var.github_branches :
    "repo:${var.github_repository}:ref:refs/heads/${branch}"
  ]
}

# IAM role assumable only by the configured GitHub repo + branch(es).
resource "aws_iam_role" "github_actions_deploy" {
  name        = "itinerarium-github-actions-deploy"
  description = "Role assumed by the GitHub Actions workflow to deploy the static site"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = local.oidc_provider_arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = local.github_sub_patterns
        }
      }
    }]
  })
}

# Minimal permissions: sync to the site bucket and invalidate the
# CloudFront distribution. Scoped to the specific bucket/distribution
# created in this stack.
data "aws_iam_policy_document" "deploy" {
  statement {
    sid = "WriteSiteBucket"
    actions = [
      "s3:PutObject",
      "s3:PutObjectAcl",
      "s3:GetObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.site.arn}/*"]
  }
  statement {
    sid       = "ListSiteBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.site.arn]
  }
  statement {
    sid = "InvalidateCloudFront"
    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
      "cloudfront:ListInvalidations",
    ]
    resources = [aws_cloudfront_distribution.site.arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.github_actions_deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
