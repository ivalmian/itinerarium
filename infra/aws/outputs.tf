output "site_url" {
  description = "Public URL of the deployed site (use as your default until a custom domain is wired up)."
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "s3_bucket_name" {
  description = "S3 bucket name. Paste into GitHub Actions repository variable AWS_S3_BUCKET."
  value       = aws_s3_bucket.site.bucket
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID. Paste into GitHub Actions repository variable AWS_CLOUDFRONT_DISTRIBUTION_ID."
  value       = aws_cloudfront_distribution.site.id
}

output "github_actions_role_arn" {
  description = "ARN of the deploy role. Paste into GitHub Actions repository variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.github_actions_deploy.arn
}

output "aws_region" {
  description = "Region the bucket lives in. Paste into GitHub Actions repository variable AWS_REGION."
  value       = var.region
}
