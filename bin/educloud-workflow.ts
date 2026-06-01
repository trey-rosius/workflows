#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EducloudWorkflowStack } from '../lib/educloud-workflow-stack';

const app = new cdk.App();
new EducloudWorkflowStack(app, 'EducloudWorkflowStack', {
  /* Specializing the stack for the active AWS Account and Region */
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT || '123456789012',
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});
