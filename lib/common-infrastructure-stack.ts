import { App, aws_ec2, Duration, RemovalPolicy, Stack, StackProps, Environment, CfnOutput } from 'aws-cdk-lib';
import {
  FlowLog,
  FlowLogDestination,
  FlowLogResourceType,
  InterfaceVpcEndpointAwsService,
  ISecurityGroup,
  IVpc,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Key } from 'aws-cdk-lib/aws-kms';

import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { getServiceAvailabilityZones } from './constants/availability-zones';
import { NETWORK_CONFIG } from './constants/network';
import { CLIENT_CONFIG } from './constants/besu';
import { NagSuppressions } from 'cdk-nag';

export interface CommonInfrastructureProps extends StackProps {
  readonly shardId: string;
  readonly stage: string;
  readonly env: Environment;
  readonly enableCrossAccountPeer?: boolean;
  readonly crossAccountPeerCidr?: string;
}

export class CommonInfrastructure extends Stack {
  public static readonly STACK_NAME = 'PrivateChainCommonInfra';
  private stage: string;
  public readonly shardId: string;
  private fleetVpc: IVpc;
  private fleetSecurityGroup: SecurityGroup;
  private fleetConfigBucket: Bucket;
  private vpcEndpointSecurityGroup: ISecurityGroup;
  region: string;

  private privateChainCommonInfrastructureS3BucketKey: Key;
  private enableCrossAccountPeer: boolean;
  private crossAccountPeerCidr?: string;
  private crossAccountTransitGateway?: aws_ec2.CfnTransitGateway;
  private crossAccountTransitGatewayAttachment?: aws_ec2.CfnTransitGatewayAttachment;
  private crossAccountTransitGatewayRouteTable?: aws_ec2.CfnTransitGatewayRouteTable;

  constructor(scope: App, id: string, props: CommonInfrastructureProps) {
    super(scope, id, props);
    this.stage = props.stage;
    this.region = props.env.region ?? 'us-east-1';
    this.shardId = props.shardId;
    this.enableCrossAccountPeer = props.enableCrossAccountPeer ?? false;
    this.crossAccountPeerCidr = props.crossAccountPeerCidr;
    this.createVPCAndSG();
    this.createKeys();
    this.createS3Buckets(props.env.account ?? '');
    this.createVPCEndpoints();
    if (this.enableCrossAccountPeer) {
      this.createCrossAccountPeerResources();
    }
    this.exportResources();
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'CdkNagValidationFailure',
        reason: 'This security group rule is intentionally permissive to allow essential peer-to-peer communication within the validator node fleet. It enables necessary data synchronization, consensus mechanisms, and other critical operations for the blockchain network. The rule is restricted to internal communication between validator nodes and does not expose the system to external threats.',
      }
    ])
  }

  private createKeys() {
    this.privateChainCommonInfrastructureS3BucketKey = new Key(this, 'PrivateChainCommonInfrastructureS3BucketKey', {
      alias: 'PrivateChainCommonInfrastructureS3BucketKey',
      description: 'KMS Key for Private Chain common infrastructure buckets',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  private createVPCAndSG() {
    this.fleetVpc = new Vpc(this, `Shard-${this.shardId}-Vpc`, {
      maxAzs: 99,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'private',
          subnetType: SubnetType.PRIVATE_ISOLATED,
        },
      ],
      gatewayEndpoints: {
        DynamoDB: {
          service: aws_ec2.GatewayVpcEndpointAwsService.DYNAMODB,
          subnets: [{ subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED }],
        },
        S3: {
          service: aws_ec2.GatewayVpcEndpointAwsService.S3,
          subnets: [{ subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED }],
        },
      },
    });

    new FlowLog(this, `Shard-${this.shardId}-VPCFlowLogs`, {
      resourceType: FlowLogResourceType.fromVpc(this.fleetVpc),
      destination: FlowLogDestination.toCloudWatchLogs(
        new LogGroup(this, 'LogGroup', {
          retention: RetentionDays.THREE_MONTHS,
        }),
      ),
    });

    this.fleetSecurityGroup = new SecurityGroup(this, `sg`, {
      vpc: this.fleetVpc,
      allowAllOutbound: false,
    });

    this.fleetSecurityGroup.addIngressRule(
      Peer.ipv4(this.fleetVpc.vpcCidrBlock),
      Port.tcp(CLIENT_CONFIG.HTTP_RPC_PORT),
      'HTTP port for AWS Auth Reverse Proxy',
    );

    this.fleetSecurityGroup.addIngressRule(
      this.fleetSecurityGroup,
      Port.tcp(CLIENT_CONFIG.DISCOVERY_PORT),
      'P2P Port for Besu Nodes',
    );
    this.fleetSecurityGroup.addIngressRule(
      this.fleetSecurityGroup,
      Port.udp(CLIENT_CONFIG.DISCOVERY_PORT),
      'P2P Port for Besu Nodes',
    );

    if (this.enableCrossAccountPeer && this.crossAccountPeerCidr) {
      this.fleetSecurityGroup.addIngressRule(
        Peer.ipv4(this.crossAccountPeerCidr),
        Port.tcp(CLIENT_CONFIG.DISCOVERY_PORT),
        'Cross-account Besu TCP P2P',
      );
      this.fleetSecurityGroup.addIngressRule(
        Peer.ipv4(this.crossAccountPeerCidr),
        Port.udp(CLIENT_CONFIG.DISCOVERY_PORT),
        'Cross-account Besu UDP P2P',
      );
      this.fleetSecurityGroup.addEgressRule(
        Peer.ipv4(this.crossAccountPeerCidr),
        Port.tcp(CLIENT_CONFIG.DISCOVERY_PORT),
        'Cross-account Besu TCP P2P',
      );
      this.fleetSecurityGroup.addEgressRule(
        Peer.ipv4(this.crossAccountPeerCidr),
        Port.udp(CLIENT_CONFIG.DISCOVERY_PORT),
        'Cross-account Besu UDP P2P',
      );
    }

    this.fleetSecurityGroup.addEgressRule(
      this.fleetSecurityGroup,
      Port.tcp(CLIENT_CONFIG.DISCOVERY_PORT),
      'P2P Port for Besu Nodes',
    );
    this.fleetSecurityGroup.addEgressRule(
      this.fleetSecurityGroup,
      Port.udp(CLIENT_CONFIG.DISCOVERY_PORT),
      'P2P Port for Besu Nodes',
    );

    this.fleetSecurityGroup.addEgressRule(
      Peer.anyIpv4(),
      Port.tcp(NETWORK_CONFIG.TLS_PORT),
      'HTTPS port will be used to contact ARPS or vpc endpoints',
    );

    this.fleetSecurityGroup.addEgressRule(
      Peer.anyIpv4(),
      Port.tcp(NETWORK_CONFIG.HTTP_PORT),
      'HTTP port will be used for patching',
    );
  }

  private createS3Buckets(serviceAccount: string): void {
    const logBucket = new Bucket(this, 'FleetAccessLogS3Bucket', {
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      bucketName: `privatechain-${this.region}-${serviceAccount}-shard-${this.shardId}-access-log-bucket`,
      removalPolicy: RemovalPolicy.RETAIN,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      bucketKeyEnabled: false,
      versioned: true,
    });

    logBucket.addLifecycleRule({
      id: 'Delete old logs',
      enabled: true,
      expiration: Duration.days(3653),
    });

    this.fleetConfigBucket = new Bucket(this, 'FleetConfigS3Bucket', {
      enforceSSL: true,
      encryption: BucketEncryption.KMS,
      bucketName: `privatechain-${this.region}-${serviceAccount}-shard-${this.shardId}-config-bucket`,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: `Shard${this.shardId}AccessLogs`,
      removalPolicy: this.stage == "dev" ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: this.stage == "dev",
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      bucketKeyEnabled: true,
      encryptionKey: this.privateChainCommonInfrastructureS3BucketKey,
      versioned: true,
    });
  }

  private createVPCEndpoints() {
    this.vpcEndpointSecurityGroup = this.createVPCEndPointSecurityGroup();

    const interfaceVpcEndpointAwsServices = [
      InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
      InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      InterfaceVpcEndpointAwsService.ECS,
      InterfaceVpcEndpointAwsService.ECS_AGENT,
      InterfaceVpcEndpointAwsService.ECS_TELEMETRY,
      InterfaceVpcEndpointAwsService.ECR_DOCKER,
      InterfaceVpcEndpointAwsService.ECR,
      InterfaceVpcEndpointAwsService.EC2,
      InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      InterfaceVpcEndpointAwsService.KMS,
      InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      InterfaceVpcEndpointAwsService.SSM,
      InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      InterfaceVpcEndpointAwsService.CLOUDFORMATION
    ];

    for (const interfaceVpcEndpointAwsService of interfaceVpcEndpointAwsServices) {
      this.fleetVpc.addInterfaceEndpoint(`${interfaceVpcEndpointAwsService.shortName}`, {
        service: interfaceVpcEndpointAwsService,
        privateDnsEnabled: true,
        lookupSupportedAzs: false,
        securityGroups: [this.vpcEndpointSecurityGroup],
        subnets: {
          subnetType: SubnetType.PRIVATE_ISOLATED,
        },
      });
    }
  }

  private createCrossAccountPeerResources(): void {
    const isolatedSubnets = this.fleetVpc.isolatedSubnets;
    if (isolatedSubnets.length === 0) {
      throw new Error('Unable to configure cross-account peer: no isolated subnets available for TGW attachment.');
    }

    this.crossAccountTransitGateway = new aws_ec2.CfnTransitGateway(this, 'CrossAccountTransitGateway', {
      description: 'Transit Gateway enabling cross-account Besu peer connectivity',
      amazonSideAsn: 64512,
      defaultRouteTableAssociation: 'disable',
      defaultRouteTablePropagation: 'disable',
      dnsSupport: 'enable',
    });

    this.crossAccountTransitGatewayRouteTable = new aws_ec2.CfnTransitGatewayRouteTable(this, 'CrossAccountTransitGatewayRouteTable', {
      transitGatewayId: this.crossAccountTransitGateway.attrId,
    });

    const attachmentSubnets = isolatedSubnets.slice(0, 2).map((subnet) => subnet.subnetId);

    this.crossAccountTransitGatewayAttachment = new aws_ec2.CfnTransitGatewayAttachment(
      this,
      'CrossAccountTransitGatewayAttachment',
      {
        transitGatewayId: this.crossAccountTransitGateway.attrId,
        vpcId: this.fleetVpc.vpcId,
        subnetIds: attachmentSubnets,
        options: {
          DnsSupport: 'enable',
          Ipv6Support: 'disable',
        },
      },
    );

    new aws_ec2.CfnTransitGatewayRouteTableAssociation(this, 'CrossAccountTransitGatewayRouteTableAssociation', {
      transitGatewayAttachmentId: this.crossAccountTransitGatewayAttachment.attrId,
      transitGatewayRouteTableId: this.crossAccountTransitGatewayRouteTable.attrTransitGatewayRouteTableId,
    });

    if (this.crossAccountPeerCidr) {
      new aws_ec2.CfnTransitGatewayRoute(this, 'CrossAccountTransitGatewayRoute', {
        destinationCidrBlock: this.crossAccountPeerCidr,
        transitGatewayAttachmentId: this.crossAccountTransitGatewayAttachment.attrId,
        transitGatewayRouteTableId: this.crossAccountTransitGatewayRouteTable.attrTransitGatewayRouteTableId,
      });
    }
  }

  private createVPCEndPointSecurityGroup(): ISecurityGroup {
    const vpcEndpointSecurityGroup = new SecurityGroup(this, `endpoint-sg`, {
      vpc: this.fleetVpc,
    });

    vpcEndpointSecurityGroup.addIngressRule(
      this.fleetSecurityGroup,
      Port.tcp(NETWORK_CONFIG.TLS_PORT),
      'All https traffic allowed from vals to vpc endpoints',
    );

    return vpcEndpointSecurityGroup;
  }

  private exportResources() {
    // Export Bucket ARN
    new CfnOutput(this, 'FleetConfigBucketArnOutput', {
      value: this.fleetConfigBucket.bucketArn,
      exportName: `FleetConfigBucketArn`,
      description: 'The ARN of the Fleet Config S3 Bucket',
    });

    // Export KMS Key ARN
    new CfnOutput(this, 'S3BucketKeyArnOutput', {
      value: this.privateChainCommonInfrastructureS3BucketKey.keyArn,
      exportName: `S3BucketKeyArn`,
      description: 'The ARN of the KMS Key for the S3 Bucket',
    });

    if (this.enableCrossAccountPeer && this.crossAccountTransitGateway) {
      new CfnOutput(this, 'CrossAccountTransitGatewayIdOutput', {
        value: this.crossAccountTransitGateway.attrId,
        exportName: 'CrossAccountTransitGatewayId',
        description: 'Transit Gateway used for cross-account peers',
      });
    }

    if (this.enableCrossAccountPeer && this.crossAccountTransitGatewayAttachment) {
      new CfnOutput(this, 'CrossAccountTransitGatewayAttachmentIdOutput', {
        value: this.crossAccountTransitGatewayAttachment.attrId,
        exportName: 'CrossAccountTransitGatewayAttachmentId',
        description: 'Transit Gateway attachment for Besu validator VPC',
      });
    }

    if (this.enableCrossAccountPeer && this.crossAccountPeerCidr) {
      new CfnOutput(this, 'CrossAccountPeerCidrOutput', {
        value: this.crossAccountPeerCidr,
        exportName: 'CrossAccountPeerCidr',
        description: 'CIDR block reserved for cross-account peers',
      });
    }
  }

  /**
   * Override this method in DeploymentStack to deploy to more than 3 AZs.
   */
  public get availabilityZones(): string[] | never {
    return getServiceAvailabilityZones(this.stage, this.region);
  }

  public getFleetVpc(): IVpc {
    return this.fleetVpc;
  }

  public getFleetSecurityGroup(): SecurityGroup {
    return this.fleetSecurityGroup;
  }

  public getFleetConfigBucket(): Bucket {
    return this.fleetConfigBucket;
  }
}
