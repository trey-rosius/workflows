import { util } from '@aws-appsync/utils';

export function request(ctx) {
  const { videoUri, title, description, summary, qa, flashcards, keyTakeaways } = ctx.args;
  
  const updateExpression = [];
  const expressionValues = {};
  const expressionNames = {};

  if (title !== undefined) {
    updateExpression.push('#title = :title');
    expressionValues[':title'] = util.dynamodb.toDynamoDB(title);
    expressionNames['#title'] = 'title';
  }
  if (description !== undefined) {
    updateExpression.push('#desc = :desc');
    expressionValues[':desc'] = util.dynamodb.toDynamoDB(description);
    expressionNames['#desc'] = 'description';
  }
  if (summary !== undefined) {
    updateExpression.push('#summary = :summary');
    expressionValues[':summary'] = util.dynamodb.toDynamoDB(summary);
    expressionNames['#summary'] = 'summary';
  }
  if (qa !== undefined) {
    updateExpression.push('#qa = :qa');
    expressionValues[':qa'] = util.dynamodb.toDynamoDB(qa);
    expressionNames['#qa'] = 'qa';
  }
  if (flashcards !== undefined) {
    updateExpression.push('#fc = :fc');
    expressionValues[':fc'] = util.dynamodb.toDynamoDB(flashcards);
    expressionNames['#fc'] = 'flashcards';
  }
  if (keyTakeaways !== undefined) {
    updateExpression.push('#kt = :kt');
    expressionValues[':kt'] = util.dynamodb.toDynamoDB(keyTakeaways);
    expressionNames['#kt'] = 'keyTakeaways';
  }

  if (updateExpression.length === 0) {
    return util.error('No fields provided to update');
  }

  return {
    operation: 'UpdateItem',
    key: {
      videoUri: util.dynamodb.toDynamoDB(videoUri),
    },
    update: {
      expression: 'SET ' + updateExpression.join(', '),
      expressionNames: expressionNames,
      expressionValues: expressionValues,
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.appendError(ctx.error.message, ctx.error.type);
    return false;
  }
  return true;
}
