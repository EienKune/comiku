-- Upgrade only the unchanged built-in template. Custom text and publication
-- snapshots remain owned by their authors and must not be rewritten.
UPDATE "publish_templates"
SET "content" = E'{{title}}\n{{body}}作者：{{author}}\n\n翻译：{{translation_credits}}\n校对：{{proofread_credits}}\n嵌字：{{typeset_credits}}\n点赞加关注可以看到更多汉化作品\n转载请注明原作者',
    "revision" = "revision" + 1,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "key" = 'default'
  AND "content" = E'**{{title}}**\n{{body}}作者：{{author}}\n\n翻译：{{translation_credits}}\n校对：{{proofread_credits}}\n嵌字：{{typeset_credits}}\n点赞加关注可以看到更多汉化作品\n转载请注明原作者';
