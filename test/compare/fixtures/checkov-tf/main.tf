# Fixture for the Checkov adapter test. Intentionally insecure: a security group
# open to the world and a public-read S3 bucket. Checkov must flag both.

resource "aws_security_group" "open" {
  name        = "open-sg"
  description = "intentionally open to the internet for the adapter test"

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_s3_bucket" "public" {
  bucket = "blast-radius-public-fixture"
}

resource "aws_s3_bucket_acl" "public" {
  bucket = aws_s3_bucket.public.id
  acl    = "public-read"
}
