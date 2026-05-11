# Itinerarium — AWS deploy infra

Static-site hosting for the viewer: a private S3 bucket fronted by
CloudFront, with a GitHub-Actions deploy role authorized via OIDC
(no long-lived AWS keys in repo secrets).

## One-time AWS bootstrap

You only run this from your laptop. After it lands once, all future
deploys go through GitHub Actions assuming the role this stack creates.

1. Install AWS CLI + Terraform:
   ```
   brew install awscli terraform
   ```
2. Get AWS credentials. Easiest for a personal account:
   - AWS console → IAM → Users → create user `terraform-bootstrap` with
     `AdministratorAccess`. Generate an access key (use-case: CLI).
   - Locally: `aws configure` and paste the key/secret/region (`us-east-1`).
   - Verify: `aws sts get-caller-identity` should print your account ID.
3. Bootstrap:
   ```
   cd infra/aws
   terraform init
   terraform apply
   ```
   Confirm the plan, type `yes`. Takes ~2 minutes (CloudFront is the slow
   step).
4. Note the outputs. You'll paste four of them into GitHub:
   ```
   terraform output
   ```
   - `s3_bucket_name`
   - `cloudfront_distribution_id`
   - `github_actions_role_arn`
   - `aws_region`

## Wire GitHub repository variables

In the GitHub UI: **Settings → Secrets and variables → Actions → Variables**
(not Secrets — these are not sensitive; the role itself is the security
boundary). Add four repository variables matching the names above:

| Variable                       | Source (terraform output)        |
|--------------------------------|----------------------------------|
| `AWS_S3_BUCKET`                | `s3_bucket_name`                 |
| `AWS_CLOUDFRONT_DISTRIBUTION_ID` | `cloudfront_distribution_id`   |
| `AWS_DEPLOY_ROLE_ARN`          | `github_actions_role_arn`        |
| `AWS_REGION`                   | `aws_region`                     |

Now push to `main` and the workflow at `.github/workflows/deploy.yml`
builds the viewer with Vite, syncs `dist/` to S3, and invalidates the
CloudFront cache. The first deploy will take ~30 seconds for the sync
+ another minute or two for CloudFront to flush.

The site URL is `terraform output -raw site_url` — looks like
`https://d3xxxxxxxx.cloudfront.net`. Hooking up a custom domain via
Route 53 and ACM is a separate add-on; ask when you want it.

## Common one-offs

- **Re-apply after editing a `.tf` file:** `terraform apply` from
  `infra/aws/`.
- **Tear it all down:** `terraform destroy`. Will empty the S3 bucket
  first; CloudFront takes a few minutes to release.
- **Existing OIDC provider:** if your account already has one for
  `token.actions.githubusercontent.com` (a previous project), the
  first apply will fail with EntityAlreadyExists. Either:
  - set `create_github_oidc_provider = false` in a `terraform.tfvars`
    file (data block picks up the existing one), or
  - `terraform import aws_iam_openid_connect_provider.github[0]
    arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`.
- **Pick a different bucket name:** S3 bucket names are globally unique.
  Override in a `terraform.tfvars`:
  ```
  bucket_name = "itinerarium-yourhandle"
  ```

## State

Terraform state lives at `infra/aws/terraform.tfstate` on your laptop.
For a hobby project this is fine — the state is small, recoverable
from AWS if lost, and never shared. If you ever want remote state
(team usage, multiple machines), the standard pattern is an S3 backend
+ DynamoDB lock table, both bootstrapped from local state first.
