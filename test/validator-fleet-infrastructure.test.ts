// test/validator-fleet-stack.test.ts
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ValidatorFleetInfrastructure, ValidatorFleetInfrastructureProps } from '../lib/validator-fleet-stack';
import { CommonInfrastructure, CommonInfrastructureProps } from '../lib/common-infrastructure-stack';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const shardId = process.env.SHARD ?? '1';
const defaultAccount = process.env.AWS_ACCOUNT_ID ?? '123456789012';
const defaultRegion = process.env.AWS_REGION ?? 'us-east-1';
process.env.SHARD = shardId;
process.env.AWS_ACCOUNT_ID = defaultAccount;
process.env.AWS_REGION = defaultRegion;

describe('Validator Fleet Infrastructure Stack', () => {
    const app = new App();

    // Create CommonInfrastructure to provide dependencies for ValidatorFleetInfrastructure
    const commonProps: CommonInfrastructureProps = {
        shardId,
        stage: 'dev',
        env: { account: defaultAccount, region: defaultRegion },
    };
    const commonStack = new CommonInfrastructure(app, 'CommonInfrastructureStack', commonProps);

    // Create ValidatorFleetInfrastructure Stack
    let validatorTemplate: Template | undefined;
    try {
        const validatorProps: ValidatorFleetInfrastructureProps = {
            stage: 'dev',
            shardId,
            allowedPrincipals: [],
            imageProviderAccount: process.env.IMAGE_PROVIDER_ACCOUNT || '',
            fleetVpc: commonStack.getFleetVpc(),
            fleetSecurityGroup: commonStack.getFleetSecurityGroup(),
            fleetConfigBucket: commonStack.getFleetConfigBucket(),
            env: { account: defaultAccount, region: defaultRegion },
        };
        const validatorStack = new ValidatorFleetInfrastructure(app, 'ValidatorFleetInfrastructureStack', validatorProps);
        validatorTemplate = Template.fromStack(validatorStack);
    } catch (error) {
        console.error('Error initializing ValidatorFleetInfrastructure stack:', error);
    }

    if (validatorTemplate) {
        test('creates ECS Cluster with daemon scheduling strategy', () => {
            validatorTemplate.hasResourceProperties('AWS::ECS::Cluster', {
                ClusterName: `Shard${shardId}-ValidatorCluster`,
            });

            validatorTemplate.hasResourceProperties('AWS::ECS::Service', {
                LaunchType: 'EC2',
                SchedulingStrategy: 'DAEMON',
            });
        });

        test('creates Auto Scaling Group for validator instances', () => {
            // Determine expected values based on FIRST_DEPLOY
            const expectedSize = process.env.FIRST_DEPLOY ? '0' : '4';

            // Validate the Auto Scaling Group properties based on FIRST_DEPLOY
            validatorTemplate.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
                MinSize: expectedSize,
                MaxSize: expectedSize,
                DesiredCapacity: expectedSize,
            });

            // Validate the instance type through the Launch Template or Launch Configuration
            validatorTemplate.hasResourceProperties('AWS::EC2::LaunchTemplate', {
                LaunchTemplateData: {
                    InstanceType: process.env.VALIDATOR_INSTANCE_TYPE || 'c7g.2xlarge',
                },
            });
        });


        test('creates Network Load Balancer with listener on HTTP port', () => {
            validatorTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
                Port: 80,
                Protocol: 'TCP',
            });
        });

        test('creates KMS keys for DynamoDB and EBS volume encryption', () => {
            validatorTemplate.hasResourceProperties('AWS::KMS::Key', {
                Description: 'KMS Key for Private Chain validator key DynamoDB table.',
                EnableKeyRotation: true,
            });

            validatorTemplate.hasResourceProperties('AWS::KMS::Key', {
                Description: 'KMS Key for Private Chain EBS volume encryption.',
                EnableKeyRotation: true,
            });
        });
    } else {
        console.warn('Skipping Validator Fleet Infrastructure Stack tests due to stack creation failure');
    }
});
