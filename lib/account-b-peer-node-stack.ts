import { App, CfnOutput, Environment, Stack, StackProps } from 'aws-cdk-lib';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import {
  CfnTransitGatewayAttachment,
  GatewayVpcEndpointAwsService,
  IVpc,
  InterfaceVpcEndpointAwsService,
  IpAddresses,
  InstanceClass,
  InstanceSize,
  InstanceType,
  MachineImage,
  Peer,
  Port,
  RouterType,
  SecurityGroup,
  Subnet,
  SubnetType,
  UserData,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Effect, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { BESU_IMAGE_TAG, CLIENT_CONFIG } from './constants/besu';

export interface AccountBPeerNodeStackProps extends StackProps {
  readonly stage: string;
  readonly shardId: string;
  readonly env: Environment;
  readonly transitGatewayId: string;
  readonly peerVpcCidr: string;
  readonly validatorVpcCidr?: string;
  readonly configBucketArn: string;
  readonly configBucketKeyArn?: string;
  readonly configBucketPrefix?: string;
  readonly genesisObjectKey?: string;
  readonly staticNodesObjectKey?: string;
  readonly peerInstanceType?: string;
}

export class AccountBPeerNodeStack extends Stack {
  public static readonly STACK_NAME = 'PrivateChainAccountBPeerNode';
  private peerVpc: IVpc;
  private peerSecurityGroup: SecurityGroup;
  private transitGatewayAttachment: CfnTransitGatewayAttachment;
  private peerAutoScalingGroup: AutoScalingGroup;

  constructor(scope: App, id: string, props: AccountBPeerNodeStackProps) {
    super(scope, id, props);

    this.peerVpc = new Vpc(this, 'PeerNodeVpc', {
      ipAddresses: IpAddresses.cidr(props.peerVpcCidr),
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'peer-private',
          subnetType: SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    this.peerVpc.addGatewayEndpoint('PeerS3GatewayEndpoint', {
      service: GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: SubnetType.PRIVATE_ISOLATED }],
    });

    this.peerSecurityGroup = new SecurityGroup(this, 'PeerNodeSecurityGroup', {
      vpc: this.peerVpc,
      allowAllOutbound: false,
    });

    const endpointSecurityGroup = new SecurityGroup(this, 'PeerEndpointSecurityGroup', {
      vpc: this.peerVpc,
      allowAllOutbound: true,
    });

    endpointSecurityGroup.addIngressRule(
      this.peerSecurityGroup,
      Port.tcp(443),
      'Allow HTTPS traffic from peer nodes to interface endpoints',
    );

    for (const service of [
      InterfaceVpcEndpointAwsService.SSM,
      InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    ]) {
      this.peerVpc.addInterfaceEndpoint(`Peer${service.shortName}Endpoint`, {
        service,
        privateDnsEnabled: true,
        securityGroups: [endpointSecurityGroup],
        subnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      });
    }

    if (props.validatorVpcCidr) {
      this.peerSecurityGroup.addIngressRule(
        Peer.ipv4(props.validatorVpcCidr),
        Port.tcp(CLIENT_CONFIG.DISCOVERY_PORT),
        'Allow inbound Besu P2P TCP from validator VPC',
      );
      this.peerSecurityGroup.addIngressRule(
        Peer.ipv4(props.validatorVpcCidr),
        Port.udp(CLIENT_CONFIG.DISCOVERY_PORT),
        'Allow inbound Besu P2P UDP from validator VPC',
      );
      this.peerSecurityGroup.addEgressRule(
        Peer.ipv4(props.validatorVpcCidr),
        Port.tcp(CLIENT_CONFIG.DISCOVERY_PORT),
        'Allow outbound Besu P2P TCP to validator VPC',
      );
      this.peerSecurityGroup.addEgressRule(
        Peer.ipv4(props.validatorVpcCidr),
        Port.udp(CLIENT_CONFIG.DISCOVERY_PORT),
        'Allow outbound Besu P2P UDP to validator VPC',
      );
    }

    this.peerSecurityGroup.addEgressRule(
      Peer.anyIpv4(),
      Port.tcp(443),
      'Allow HTTPS egress for S3, SSM, and container registry access',
    );

    const peerNodeRole = new Role(this, 'PeerNodeRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });

    peerNodeRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [props.configBucketArn, `${props.configBucketArn}/*`],
      }),
    );

    if (props.configBucketKeyArn) {
      peerNodeRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['kms:Decrypt', 'kms:DescribeKey'],
          resources: [props.configBucketKeyArn],
        }),
      );
    }

    const isolatedSubnets = this.peerVpc.isolatedSubnets.slice(0, 2).map((subnet) => subnet as Subnet);
    if (isolatedSubnets.length === 0) {
      throw new Error('Peer VPC requires isolated subnets for TGW attachment.');
    }

    this.transitGatewayAttachment = new CfnTransitGatewayAttachment(this, 'PeerTransitGatewayAttachment', {
      transitGatewayId: props.transitGatewayId,
      vpcId: this.peerVpc.vpcId,
      subnetIds: isolatedSubnets.map((subnet) => subnet.subnetId),
      options: {
        DnsSupport: 'enable',
        Ipv6Support: 'disable',
      },
    });

    if (props.validatorVpcCidr) {
      isolatedSubnets.forEach((subnet, index) => {
        subnet.addRoute(`PeerToValidatorRoute${index}`, {
          destinationCidrBlock: props.validatorVpcCidr,
          routerId: props.transitGatewayId,
          routerType: RouterType.TRANSIT_GATEWAY,
          enablesInternetConnectivity: false,
        });
      });
    }

    const bucketName = props.configBucketArn.replace('arn:aws:s3:::', '');
    if (!bucketName) {
      throw new Error('Unable to derive configuration bucket name from ARN.');
    }

    const objectPrefix = props.configBucketPrefix
      ? props.configBucketPrefix.replace(/^\//, '').replace(/\/$/, '') + '/'
      : '';
    const genesisObjectKey = `${objectPrefix}${props.genesisObjectKey ?? CLIENT_CONFIG.GENESIS_FILE_NAME}`;
    const staticNodesObjectKey = `${objectPrefix}${props.staticNodesObjectKey ?? CLIENT_CONFIG.BOOTNODES_FILE_NAME}`;

    const peerUserData = UserData.forLinux();
    peerUserData.addCommands(
      'set -euxo pipefail',
      'yum update -y',
      'yum install -y awscli jq',
      'amazon-linux-extras install docker -y',
      'systemctl enable docker',
      'systemctl start docker',
      'usermod -a -G docker ec2-user || true',
      'mkdir -p /opt/besu/config',
      `aws s3 cp s3://${bucketName}/${genesisObjectKey} /opt/besu/config/${CLIENT_CONFIG.GENESIS_FILE_NAME}`,
      `aws s3 cp s3://${bucketName}/${staticNodesObjectKey} /opt/besu/config/${CLIENT_CONFIG.BOOTNODES_FILE_NAME}`,
      "cat <<'EOF' >/opt/besu/run-besu.sh",
      '#!/bin/bash',
      'set -euxo pipefail',
      'docker rm -f besu || true',
      `docker run -d --name besu \\
  -v /opt/besu/config:${CLIENT_CONFIG.CONFIG_DIR}:ro \\
  -p ${CLIENT_CONFIG.DISCOVERY_PORT}:${CLIENT_CONFIG.DISCOVERY_PORT}/tcp \\
  -p ${CLIENT_CONFIG.DISCOVERY_PORT}:${CLIENT_CONFIG.DISCOVERY_PORT}/udp \\
  hyperledger/besu:${BESU_IMAGE_TAG} \\
  --data-path=${CLIENT_CONFIG.DATA_DIR} \\
  --genesis-file=${CLIENT_CONFIG.CONFIG_DIR}/${CLIENT_CONFIG.GENESIS_FILE_NAME} \\
  --p2p-host=$(curl -s http://169.254.169.254/latest/meta-data/local-ipv4) \\
  --p2p-port=${CLIENT_CONFIG.DISCOVERY_PORT} \\
  --static-nodes-file=${CLIENT_CONFIG.CONFIG_DIR}/${CLIENT_CONFIG.BOOTNODES_FILE_NAME} \\
  --rpc-http-enabled=false`,
      'EOF',
      'chmod +x /opt/besu/run-besu.sh',
      'nohup /opt/besu/run-besu.sh >/var/log/besu.log 2>&1 &',
    );

    const instanceType = props.peerInstanceType
      ? new InstanceType(props.peerInstanceType)
      : InstanceType.of(InstanceClass.C6I, InstanceSize.LARGE);

    this.peerAutoScalingGroup = new AutoScalingGroup(this, 'PeerNodeAsg', {
      vpc: this.peerVpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      minCapacity: 1,
      desiredCapacity: 1,
      maxCapacity: 1,
      instanceType,
      machineImage: MachineImage.latestAmazonLinux2(),
      securityGroup: this.peerSecurityGroup,
      role: peerNodeRole,
      userData: peerUserData,
    });

    new CfnOutput(this, 'PeerNodeVpcIdOutput', {
      value: this.peerVpc.vpcId,
      exportName: 'AccountBPeerNodeVpcId',
      description: 'VPC hosting the Account B peer node',
    });

    new CfnOutput(this, 'PeerNodeSecurityGroupIdOutput', {
      value: this.peerSecurityGroup.securityGroupId,
      exportName: 'AccountBPeerNodeSecurityGroupId',
      description: 'Security group assigned to the Account B peer node',
    });

    new CfnOutput(this, 'PeerTransitGatewayAttachmentIdOutput', {
      value: this.transitGatewayAttachment.attrId,
      exportName: 'AccountBPeerTransitGatewayAttachmentId',
      description: 'Transit Gateway attachment connecting Account B peer VPC to Account A',
    });

    new CfnOutput(this, 'PeerNodeAsgNameOutput', {
      value: this.peerAutoScalingGroup.autoScalingGroupName,
      exportName: 'AccountBPeerNodeAsgName',
      description: 'Auto Scaling group maintaining the single peer node instance',
    });
  }
}
