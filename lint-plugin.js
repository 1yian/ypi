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

const killByName = /\b(pkill|killall)\b/;

const noKillByName = {
  meta: {
    type: "problem",
    messages: {
      kill: "Never kill a process by name in e2e code; stop only processes you started by pid or process group.",
    },
  },
  create: (context) => ({
    Literal: (node) => {
      if (typeof node.value === "string" && killByName.test(node.value)) {
        context.report({ node, messageId: "kill" });
      }
    },
    TemplateElement: (node) => {
      if (killByName.test(node.value.raw)) {
        context.report({ node, messageId: "kill" });
      }
    },
  }),
};

export default {
  meta: { name: "ypi" },
  rules: { "no-comments": noComments, "no-kill-by-name": noKillByName },
};
