# fix-B locks the bucket down with a public-access block (Checkov no longer flags
# it public), but leaves the IAM policy broad (s3:* on the lake).
resource "aws_s3_bucket" "lake" {
  bucket = "pipeline-lake"
}

resource "aws_s3_bucket_public_access_block" "lake" {
  bucket                  = aws_s3_bucket.lake.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
