import { util } from '@aws-appsync/utils';

export function request(ctx) {
  return {
    operation: 'GetItem',
    key: {
      videoUri: util.dynamodb.toDynamoDB(ctx.args.videoUri),
    },
  };
}

export function response(ctx) {
  return ctx.result;
}
