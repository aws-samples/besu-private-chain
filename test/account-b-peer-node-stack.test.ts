import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AccountBPeerNodeStack, AccountBPeerNodeStackProps } from '../lib/account-b-peer-node-stack';

describe('AccountBPeerNodeStack', () => {
  const app = new App();
  const props: AccountBPeerNodeStackProps = {
    stage: 'dev',
    shardId: '1',
    env: { account: '000000000000', region: 'us-east-1' },
    transitGatewayId: 'tgw-0123456789abcdef0',
    peerVpcCidr: '10.70.0.0/16',
    validatorVpcCidr: '10.60.0.0/16',
    configBucketArn: 'arn:aws:s3:::privatechain-config-bucket',
    configBucketKeyArn: 'arn:aws:kms:us-east-1:000000000000:key/example',
  };

  const stack = new AccountBPeerNodeStack(app, 'AccountBPeerNodeStack', props);
  const template = Template.fromStack(stack);

  test('creates peer VPC with expected CIDR', () => {
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: props.peerVpcCidr,
    });
  });

  test('creates TGW attachment for peer VPC', () => {
    template.resourceCountIs('AWS::EC2::TransitGatewayAttachment', 1);
  });

  test('creates IAM policy for peer node role', () => {
    template.resourceCountIs('AWS::IAM::Policy', 1);
  });

  test('creates Auto Scaling group for peer node', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '1',
      MaxSize: '1',
      DesiredCapacity: '1',
    });
  });
});
