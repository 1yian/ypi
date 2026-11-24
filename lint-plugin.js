const allowedComment = (comment) =>
  comment.type === "Shebang" ||
  (comment.type === "Line" && /^\/ <reference lib="[a-z.]+" \/>$/.test(comment.value));

const noComments = {
  meta: { type: "suggestion", messages: { comment: "Comments are not allowed in code." } },
  create: (context) => ({
    Program: () => {
      for (const comment of context.sourceCode.getAllComments()) {
        if (!allowedComment(comment)) {
          context.report({ loc: comment.loc, messageId: "comment" });
        }
      }
    },
  }),
};

export default {
  meta: { name: "ypi" },
  rules: { "no-comments": noComments },
};
