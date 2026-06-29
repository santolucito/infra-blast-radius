window.__GRAPHS = {
  "cloudformation": {
    "graph": {
      "schemaVersion": 1,
      "provider": "cloudformation",
      "nodes": [
        {
          "id": "VPC",
          "label": "VPC (VPC)",
          "type": "network",
          "module": null,
          "severity": null
        },
        {
          "id": "InternetGateway",
          "label": "InternetGateway (InternetGateway)",
          "type": "network",
          "module": null,
          "severity": null
        },
        {
          "id": "GatewayAttachment",
          "label": "VPCGatewayAttachment (GatewayAttachment)",
          "type": "network",
          "module": null,
          "severity": null
        },
        {
          "id": "PublicSubnet",
          "label": "Subnet (PublicSubnet)",
          "type": "network",
          "module": null,
          "severity": null
        },
        {
          "id": "WebSecurityGroup",
          "label": "SecurityGroup (WebSecurityGroup)",
          "type": "network",
          "module": null,
          "severity": null
        },
        {
          "id": "WebServer",
          "label": "Instance (WebServer)",
          "type": "compute",
          "module": null,
          "severity": null
        }
      ],
      "edges": [
        {
          "id": "GatewayAttachment->VPC",
          "source": "GatewayAttachment",
          "target": "VPC",
          "kind": "hard"
        },
        {
          "id": "GatewayAttachment->InternetGateway",
          "source": "GatewayAttachment",
          "target": "InternetGateway",
          "kind": "hard"
        },
        {
          "id": "PublicSubnet->VPC",
          "source": "PublicSubnet",
          "target": "VPC",
          "kind": "hard"
        },
        {
          "id": "WebSecurityGroup->VPC",
          "source": "WebSecurityGroup",
          "target": "VPC",
          "kind": "hard"
        },
        {
          "id": "WebServer->PublicSubnet",
          "source": "WebServer",
          "target": "PublicSubnet",
          "kind": "hard"
        },
        {
          "id": "WebServer->WebSecurityGroup",
          "source": "WebServer",
          "target": "WebSecurityGroup",
          "kind": "hard"
        },
        {
          "id": "WebServer->VPC",
          "source": "WebServer",
          "target": "VPC",
          "kind": "hard"
        },
        {
          "id": "WebServer->GatewayAttachment",
          "source": "WebServer",
          "target": "GatewayAttachment",
          "kind": "soft"
        }
      ],
      "warnings": []
    },
    "label": "network.yaml"
  },
  "terraform": {
    "graph": {
      "schemaVersion": 1,
      "provider": "terraform",
      "nodes": [
        {
          "id": "aws_instance.web",
          "label": "aws_instance.web",
          "type": "compute",
          "module": null,
          "severity": null
        },
        {
          "id": "aws_security_group.web",
          "label": "aws_security_group.web",
          "type": "network",
          "module": null,
          "severity": null
        },
        {
          "id": "aws_subnet.public_a",
          "label": "aws_subnet.public_a",
          "type": "network",
          "module": null,
          "severity": null
        },
        {
          "id": "aws_vpc.main",
          "label": "aws_vpc.main",
          "type": "network",
          "module": null,
          "severity": null
        }
      ],
      "edges": [
        {
          "id": "aws_instance.web->aws_security_group.web",
          "source": "aws_instance.web",
          "target": "aws_security_group.web",
          "kind": "hard"
        },
        {
          "id": "aws_instance.web->aws_subnet.public_a",
          "source": "aws_instance.web",
          "target": "aws_subnet.public_a",
          "kind": "hard"
        },
        {
          "id": "aws_security_group.web->aws_vpc.main",
          "source": "aws_security_group.web",
          "target": "aws_vpc.main",
          "kind": "hard"
        },
        {
          "id": "aws_subnet.public_a->aws_vpc.main",
          "source": "aws_subnet.public_a",
          "target": "aws_vpc.main",
          "kind": "hard"
        }
      ],
      "warnings": []
    },
    "label": "examples/terraform"
  }
};