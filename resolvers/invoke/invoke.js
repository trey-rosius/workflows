export function request(ctx) {
  return {
    operation: 'Invoke',
    payload: {
      arguments: ctx.args,
      info: ctx.info,
    },
  };
}

export function response(ctx) {
  return ctx.result;
}
