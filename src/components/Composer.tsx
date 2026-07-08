import {
  Code,
  ListBullets,
  ListNumbers,
  PaperPlaneTilt,
  Quotes,
  TextB,
  TextItalic,
  TextStrikethrough,
  X,
} from "@phosphor-icons/react";
import Placeholder from "@tiptap/extension-placeholder";
import { Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";
import { MentionTarget } from "../lib/mentions";
import { Effort } from "../types";
import { ModelEffortSelector } from "./ModelEffortSelector";

interface ReplyPreview {
  authorName: string;
  snippet: string;
}

interface ToolbarAction {
  label: string;
  icon: typeof TextB;
  isActive: string;
  run: (editor: Editor) => void;
}

const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { label: "Bold", icon: TextB, isActive: "bold", run: (e) => e.chain().focus().toggleBold().run() },
  { label: "Italic", icon: TextItalic, isActive: "italic", run: (e) => e.chain().focus().toggleItalic().run() },
  {
    label: "Strikethrough",
    icon: TextStrikethrough,
    isActive: "strike",
    run: (e) => e.chain().focus().toggleStrike().run(),
  },
  { label: "Code", icon: Code, isActive: "code", run: (e) => e.chain().focus().toggleCode().run() },
  {
    label: "Bulleted list",
    icon: ListBullets,
    isActive: "bulletList",
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    label: "Numbered list",
    icon: ListNumbers,
    isActive: "orderedList",
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    label: "Quote",
    icon: Quotes,
    isActive: "blockquote",
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
];

interface MentionQuery {
  prefix: "@" | "#";
  term: string;
  from: number;
  to: number;
}

interface Props {
  placeholder: string;
  disabled?: boolean;
  onSend: (markdown: string) => void;
  showModelEffort?: boolean;
  model: string;
  effort: Effort;
  onModelChange: (m: string) => void;
  onEffortChange: (e: Effort) => void;
  mentionTargets?: MentionTarget[];
  replyPreview?: ReplyPreview | null;
  onCancelReply?: () => void;
}

export function Composer({
  placeholder,
  disabled,
  onSend,
  showModelEffort,
  model,
  effort,
  onModelChange,
  onEffortChange,
  mentionTargets,
  replyPreview,
  onCancelReply,
}: Props) {
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null);
  const mentionTargetsRef = useRef(mentionTargets);
  useLayoutEffect(() => {
    mentionTargetsRef.current = mentionTargets;
  });

  const mentionOptions = useMemo(() => {
    if (!mentionQuery || !mentionTargets) return [];
    const wantType = mentionQuery.prefix === "@" ? "employee" : "channel";
    const term = mentionQuery.term.toLowerCase();
    return mentionTargets
      .filter((t) => t.type === wantType && t.label.toLowerCase().includes(term))
      .slice(0, 8);
  }, [mentionQuery, mentionTargets]);

  const mentionOptionsCountRef = useRef(0);
  useLayoutEffect(() => {
    mentionOptionsCountRef.current = mentionOptions.length;
  });

  const disabledRef = useRef(disabled);
  useLayoutEffect(() => {
    disabledRef.current = disabled;
  });

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
        Placeholder.configure({ placeholder }),
        Markdown.configure({ html: false, linkify: true, breaks: false }),
      ],
      content: "",
      editorProps: {
        attributes: { class: "composer-editor" },
        handleKeyDown: (_view, event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
            if (mentionOptionsCountRef.current > 0) return false;
            event.preventDefault();
            submitRef.current();
            return true;
          }
          if (event.key === "Escape") {
            setMentionQuery(null);
          }
          return false;
        },
      },
      onUpdate: ({ editor }) => detectMentionRef.current(editor),
      onSelectionUpdate: ({ editor }) => detectMentionRef.current(editor),
    },
    [placeholder],
  );

  const detectMentionRef = useRef((editor: NonNullable<ReturnType<typeof useEditor>>) => {
    const { from } = editor.state.selection;
    const textBefore = editor.state.doc.textBetween(0, from, "\n");
    const match = textBefore.match(/(^|\s)([@#])(\w*)$/);
    if (match && mentionTargetsRef.current) {
      const term = match[3];
      const prefix = match[2] as "@" | "#";
      const mentionStart = from - (prefix.length + term.length);
      setMentionQuery({ prefix, term, from: mentionStart, to: from });
    } else {
      setMentionQuery(null);
    }
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const isEmpty = useEditorState({
    editor,
    selector: (ctx) => ctx.editor?.isEmpty ?? true,
  });

  const activeMarks = useEditorState({
    editor,
    selector: (ctx) =>
      new Set(TOOLBAR_ACTIONS.filter((a) => ctx.editor?.isActive(a.isActive)).map((a) => a.isActive)),
  });

  const submitRef = useRef(() => {});
  useLayoutEffect(() => {
    submitRef.current = () => {
      if (!editor || editor.isEmpty || disabledRef.current) return;
      const markdown: string = editor.storage.markdown.getMarkdown().trim();
      if (!markdown) return;
      onSend(markdown);
      editor.commands.clearContent();
      setMentionQuery(null);
    };
  });

  const pickMention = (target: MentionTarget) => {
    if (!mentionQuery || !editor) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: mentionQuery.from, to: mentionQuery.to }, `${mentionQuery.prefix}${target.label} `)
      .run();
    setMentionQuery(null);
  };

  return (
    <div className="composer-wrap">
      {replyPreview && (
        <div className="composer-reply-bar">
          <span>
            Replying to <strong>{replyPreview.authorName}</strong>: {replyPreview.snippet}
          </span>
          <button className="composer-reply-cancel" onClick={onCancelReply}>
            <X />
          </button>
        </div>
      )}
      <div className={`composer-card ${disabled ? "composer-card-disabled" : ""}`}>
        <div className="composer-format-toolbar">
          {TOOLBAR_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`format-btn ${editor && activeMarks.has(action.isActive) ? "active" : ""}`}
              title={action.label}
              disabled={!editor || disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor && action.run(editor)}
            >
              <action.icon size={15} weight={editor && activeMarks.has(action.isActive) ? "fill" : "regular"} />
            </button>
          ))}
        </div>

        <div className="composer-input-wrap">
          {mentionOptions.length > 0 && (
            <div className="mention-autocomplete">
              {mentionOptions.map((t) => (
                <button
                  key={t.conversationId}
                  className="mention-autocomplete-item"
                  onClick={() => pickMention(t)}
                >
                  {mentionQuery?.prefix}
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <EditorContent editor={editor} className="composer-editor-wrap" />
        </div>

        <div className="composer-bottom-bar">
          {showModelEffort ? (
            <ModelEffortSelector
              model={model}
              effort={effort}
              onModelChange={onModelChange}
              onEffortChange={onEffortChange}
              disabled={disabled}
            />
          ) : (
            <span />
          )}
          <button
            className="send-button"
            title="Send"
            disabled={disabled || !editor || isEmpty}
            onClick={() => submitRef.current()}
          >
            <PaperPlaneTilt weight="fill" />
          </button>
        </div>
      </div>
    </div>
  );
}
