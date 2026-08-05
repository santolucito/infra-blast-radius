# fix-A leaves the bucket's exposure untouched: still no public-access block, so
# Checkov still flags it public. The fix here is only to the IAM policy.
resource "aws_s3_bucket" "lake" {
  bucket = "pipeline-lake"
}
