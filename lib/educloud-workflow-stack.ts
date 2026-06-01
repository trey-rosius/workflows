import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AppSyncConstruct } from './appsync-construct';

export class EducloudWorkflowStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Instantiate the AppSync and video embedding pipeline construct
    new AppSyncConstruct(this, 'AppSyncWorkflowConstruct');
  }
}
