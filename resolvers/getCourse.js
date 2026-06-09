import { util } from '@aws-appsync/utils';

export function request(ctx) {
  return {
    operation: 'GetItem',
    key: {
      courseId: util.dynamodb.toDynamoDB(ctx.args.courseId),
    },
  };
}

export function response(ctx) {
  return ctx.result;
}
