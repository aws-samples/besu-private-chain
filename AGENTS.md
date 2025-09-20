# Repository Guidelines

This repository provisions a private Hyperledger Besu network with AWS CDK.

## Project Structure & Module Organization
- Root `app.ts` synthesizes stacks from `lib/`.
- Core stacks live in `lib/common-infrastructure-stack.ts` and `lib/validator-fleet-stack.ts`; shared constructs and config sit in `lib/constructs/`, `lib/config/`, and `lib/constants/`.
- Cross-account onboarding starts in `lib/account-b-peer-node-stack.ts`, which provisions the partner VPC, security group, and TGW attachment skeleton.
- Helpers reside in `lib/lambda-functions/`, genesis in `lib/genesis/`, tests in `test/*.test.ts`, and collateral in `doc/assets/` and `scripts/`.

## Build, Test, and Development Commands
- `npm install` (or `npm ci`) prepares dependencies.
- `npm run build` compiles TypeScript via `tsc`.
- `npm run test` executes the Jest suite.
- `npm run cdk synth` validates templates, and `npm run cdk deploy -- <StackName>` performs targeted deployments.

## Coding Style & Naming Conventions
- Use 2-space indentation, single quotes, and explicit `export` statements across TypeScript files.
- Apply `PascalCase` for constructs, `camelCase` for functions and variables, and `SCREAMING_SNAKE_CASE` for shared constants (`NETWORK_CONFIG`).
- Extract reusable logic into `lib/constructs/` or helpers and pick descriptive method names (`createVPCEndpoints`).
- Run `npx prettier "{lib,test}/**/*.ts" --check` before submitting.

## Testing Guidelines
- Author or update `*.test.ts` files whenever infrastructure or helpers change, using CDK assertions and snapshot updates to cover new resources.
- Keep test titles descriptive (for example, `shouldCreatePrivateSubnets`) and group related expectations within a single scenario.
- Ensure tests pass locally with `npm run test`; capture `npm run cdk synth` output when manual review is required.

## Commit & Pull Request Guidelines
- Use short, imperative commit subjects similar to `add validator metrics dashboard`; expand in the body when needed.
- Summarize architectural impact, link tickets, note environment variable changes, and include validation proof in every PR.
- Update documentation (`README.md`, `.env-sample`, diagrams) whenever defaults, networking, or operator workflows shift.

## Environment & Security Notes
- Base new environment files on `.env-sample` and store real secrets in AWS Parameter Store or Secrets Manager.
- Review IAM and networking modifications with `npm run cdk synth`, and justify any `cdk-nag` suppressions inline as shown in `lib/common-infrastructure-stack.ts`.
