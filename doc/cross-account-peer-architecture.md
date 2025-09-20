# Cross-Account Peer/Validator Architecture (Draft)

## Goals
- Allow partnered AWS accounts to join the Besu network with a single validator or peer node.
- Keep JSON-RPC traffic on the existing PrivateLink endpoint while routing P2P discovery/gossip over dedicated networking.
- Minimize blast radius by isolating cross-account connectivity to specific subnets, ports, and security groups.

## High-Level Design

### Account A (Network Owner)
- **Existing Components**
  - Besu validator fleet deployed in private subnets of `Shard-<id>-Vpc`.
  - Network Load Balancer + PrivateLink endpoint service exposes RPC via port `8545`.
- **New Components**
  1. **Transit Gateway (TGW)**
     - Deployed in Account A and shared via AWS RAM to partner accounts.
     - TGW route table restricts propagation to Besu private subnets only.
  2. **TGW VPC Attachment**
     - Attach `Shard-<id>-Vpc` isolated subnets to the TGW using private subnets dedicated to P2P traffic.
     - Create separate route table for the attachment to ensure only P2P CIDR ranges are reachable.
  3. **Security Groups & NACLs**
     - Extend node security group to allow inbound/outbound TCP/UDP `30303` (Besu discovery) from the TGW attachment CIDRs.
     - Keep RPC SG limited to the PrivateLink NLB subnets.
  4. **RAM Share**
     - Share TGW and the `enableCrossAccountPeer` configuration via CloudFormation exports or SSM parameters.

### Account B (Participant)
- **Networking**
  - Deploy `AccountBPeerNodeStack` to create `PeerNodeVpc` (default `10.70.0.0/16`) with isolated subnets for the peer node.
  - Accept the RAM share for Account A's TGW and attach the isolated subnets using the stack's `transitGatewayId` property.
- **Compute**
  - The stack provisions a single-instance Auto Scaling group running an AMI-based Besu node (Docker) that syncs `genesis.json` and `static-nodes.json` from Account A's configuration bucket at boot.
  - Enforce SG rules that allow TCP/UDP `30303` traffic between the peer VPC and the validator VPC; keep RPC access on PrivateLink.
- **Routing**
  - The stack adds per-subnet routes to send validator CIDRs over the TGW; Account A updates the TGW route table to send return traffic to the peer attachment.
  - Keep default routes contained within Account B; add explicit egress only for approved services (e.g., SSM, monitoring endpoints).

## Traffic Flows
- **RPC**: Account B workloads connect through the existing PrivateLink (Interface Endpoint) to reach the RPC reverse proxy/NLB in Account A. No changes to RPC path.
- **P2P Discovery/Gossip**: Besu nodes use TCP/UDP `30303` over TGW attachments. Security groups limit scope to validator subnets and peer node subnets.
- **Monitoring/Telemetry**: Optional—allow outbound HTTPS (`443`) from Account B node to Account A monitoring endpoints (e.g., CloudWatch) only if needed; otherwise rely on local logging.

## Operational Considerations
- **CIDR Plan**: Reserve `10.60.0.0/16` for Account A Besu VPC validator subnets (existing deployment) and `10.70.0.0/16` for Account B peer VPC. Adjust if existing allocations conflict, but preserve non-overlapping `/24` slices dedicated to TGW attachments (for example, `10.60.10.0/24` in Account A and `10.70.10.0/24` in Account B).
- **IAM & Secrets**: Store genesis and static-node artifacts in the existing `FleetConfigS3Bucket`. Create a resource policy that grants cross-account read to an IAM role (`AccountBPeerNodeRole`) in Account B. Optionally replicate objects to an Account B bucket if data locality is required, but avoid duplicate truth sources.
- **Automation**: Introduce `enableCrossAccountPeer` flag in `CommonInfrastructure` to conditionally create TGW resources, routes, and exports. Provide CloudFormation outputs for TGW IDs, attachment subnet IDs, and S3 artifact ARNs used by Account B.
- **Validation**
  - Update Jest tests to assert TGW resources exist when flag is true.
  - Add integration runbook: `npm run cdk deploy -- CommonInfra` (with context flag) followed by `npm run cdk deploy -- AccountBPeerNodeStack` in the partner account.
- **Cost/Scaling**: Start with a single TGW route table and small EC2 footprint. Revisit autoscaling for peer node if future throughput requires.

## Open Questions / Follow-Up
1. Validate the proposed CIDR plan (`10.60.0.0/16` + `10.70.0.0/16`) with production networking to catch overlaps early.
2. Confirm with the security team whether cross-account S3 access is sufficient or if secrets replication via Secrets Manager is required.
3. Define decommission procedure for TGW attachments when partners leave the consortium.
