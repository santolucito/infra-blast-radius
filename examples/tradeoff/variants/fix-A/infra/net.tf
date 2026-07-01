# fix-A network: opened to the internet to reach an external license server.
# SG allows all traffic from 0.0.0.0/0 and the instance gets a public IP.
resource "aws_security_group" "job" {
  name = "job"
  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "job" {
  ami                         = "ami-123"
  instance_type               = "t3.micro"
  associate_public_ip_address = true
}
