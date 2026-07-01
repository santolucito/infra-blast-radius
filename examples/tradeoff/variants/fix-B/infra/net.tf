# fix-B network: unchanged from baseline — stays locked down (private).
resource "aws_security_group" "job" {
  name = "job"
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }
}

resource "aws_instance" "job" {
  ami                         = "ami-123"
  instance_type               = "t3.micro"
  associate_public_ip_address = false
}
