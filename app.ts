#!/usr/bin/env node
import 'dotenv/config'
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import * as nag from "cdk-nag";
import { ArnPrincipal } from 'aws-cdk-lib/aws-iam';

import { CommonInfrastructure } from "./lib/common-infrastructure-stack";
import { ValidatorFleetInfrastructure, ValidatorFleetInfrastructureProps } from "./lib/validator-fleet-stack";
import { AccountBPeerNodeStack, AccountBPeerNodeStackProps } from "./lib/account-b-peer-node-stack";

function coerceBoolean(value: unknown, fallbackEnv?: string): boolean {
    if (typeof value === 'string') {
        return value.toLowerCase() === 'true';
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (fallbackEnv) {
        return process.env[fallbackEnv] === 'true';
    }
    return false;
}

function coerceString(value: unknown, fallbackEnv?: string): string | undefined {
    if (typeof value === 'string' && value.length > 0) {
        return value;
    }
    if (fallbackEnv) {
        const envValue = process.env[fallbackEnv];
        if (envValue && envValue.length > 0) {
            return envValue;
        }
    }
    return undefined;
}

const app = new cdk.App();
cdk.Tags.of(app).add("Project", "PrivateChain");

if (process.env.USER && process.env.AWS_ACCOUNT_ID) {
    const stackEnv = {
        region: process.env.AWS_REGION ?? 'us-east-1',
        account: process.env.AWS_ACCOUNT_ID
    };
    const enableCrossAccountPeer = coerceBoolean(app.node.tryGetContext('enableCrossAccountPeer'), 'ENABLE_CROSS_ACCOUNT_PEER');
    const crossAccountPeerCidr = coerceString(app.node.tryGetContext('crossAccountPeerCidr'), 'CROSS_ACCOUNT_PEER_CIDR');

    const devCommonInfraStack = new CommonInfrastructure(
        app,
        `dev-noderunners-${process.env.USER}-${CommonInfrastructure.STACK_NAME}`,
        {
            shardId: '1',
            stage: 'dev',
            env: stackEnv,
            enableCrossAccountPeer,
            crossAccountPeerCidr,
        },
    );
    const devValidatorFleetInfraProps: ValidatorFleetInfrastructureProps = {
        stage: 'dev',
        shardId: process.env.SHARD ?? '3',
        allowedPrincipals: [new ArnPrincipal(`arn:aws:iam::${stackEnv.account}:root`)],
        imageProviderAccount: stackEnv.account,
        fleetVpc: devCommonInfraStack.getFleetVpc(),
        fleetSecurityGroup: devCommonInfraStack.getFleetSecurityGroup(),
        fleetConfigBucket: devCommonInfraStack.getFleetConfigBucket(),
        env: stackEnv
    };

    const devValidatorFleetStack = new ValidatorFleetInfrastructure(
        app,
        `dev-noderunners-${process.env.USER}-${ValidatorFleetInfrastructure.STACK_NAME}`,
        devValidatorFleetInfraProps,
    );

    const deployAccountBPeerNode = coerceBoolean(app.node.tryGetContext('deployAccountBPeerNode'), 'DEPLOY_ACCOUNT_B_PEER_NODE');
    if (deployAccountBPeerNode) {
        const accountBAccount = coerceString(app.node.tryGetContext('accountBAccountId'), 'ACCOUNT_B_AWS_ACCOUNT_ID') ?? stackEnv.account;
        const accountBRegion = coerceString(app.node.tryGetContext('accountBRegion'), 'ACCOUNT_B_AWS_REGION') ?? stackEnv.region;
        const peerVpcCidr = coerceString(app.node.tryGetContext('peerVpcCidr'), 'PEER_VPC_CIDR') ?? '10.70.0.0/16';
        const validatorVpcCidr = coerceString(app.node.tryGetContext('validatorVpcCidr'), 'VALIDATOR_VPC_CIDR') ?? crossAccountPeerCidr;
        const transitGatewayId = coerceString(app.node.tryGetContext('transitGatewayId'), 'TRANSIT_GATEWAY_ID');
        const configBucketArn = coerceString(app.node.tryGetContext('configBucketArn'), 'CONFIG_BUCKET_ARN');
        const configBucketKeyArn = coerceString(app.node.tryGetContext('configBucketKeyArn'), 'CONFIG_BUCKET_KEY_ARN');
        const genesisObjectKey = coerceString(app.node.tryGetContext('genesisObjectKey'), 'GENESIS_OBJECT_KEY');
        const staticNodesObjectKey = coerceString(app.node.tryGetContext('staticNodesObjectKey'), 'STATIC_NODES_OBJECT_KEY');
        const configBucketPrefix = coerceString(app.node.tryGetContext('configBucketPrefix'), 'CONFIG_BUCKET_PREFIX');
        const peerInstanceType = coerceString(app.node.tryGetContext('peerInstanceType'), 'PEER_INSTANCE_TYPE');

        if (!transitGatewayId) {
            throw new Error('Missing transit gateway id. Provide via context key "transitGatewayId" or env TRANSIT_GATEWAY_ID.');
        }
        if (!configBucketArn) {
            throw new Error('Missing config bucket ARN. Provide via context key "configBucketArn" or env CONFIG_BUCKET_ARN.');
        }

        const accountBEnv = {
            region: accountBRegion,
            account: accountBAccount,
        };

        const accountBStackProps: AccountBPeerNodeStackProps = {
            stage: 'dev',
            shardId: process.env.SHARD ?? '1',
            env: accountBEnv,
            transitGatewayId,
            peerVpcCidr,
            validatorVpcCidr,
            configBucketArn,
            configBucketKeyArn,
            configBucketPrefix,
            genesisObjectKey,
            staticNodesObjectKey,
            peerInstanceType,
        };

        new AccountBPeerNodeStack(
            app,
            `dev-noderunners-${process.env.USER}-${AccountBPeerNodeStack.STACK_NAME}`,
            accountBStackProps,
        );
    }
} else {
    console.error("Set AWS_ACCOUNT_ID and USER in your env to deploy the prototype.");
}

// TODO : Enable Nag and fix all nag issues.

cdk.Aspects.of(app).add(
    new nag.AwsSolutionsChecks({
        verbose: false,
        reports: true,
        logIgnores: false,
    })
);
