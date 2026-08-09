# The analytics data lake. In the baseline it has no public-access block, so
# Checkov flags it publicly reachable (CKV2_AWS_6 -> public_exposure).
resource "aws_s3_bucket" "lake" {
  bucket = "pipeline-lake"
}
