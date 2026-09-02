import { useState, useMemo, lazy, Suspense, type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ContentBlock } from "../types.js";
import { ToolBlock, getToolIcon, getToolLabel, getPreview, ToolIcon } from "./ToolBlock.js";

const MermaidDiagram = lazy(() => import("./MermaidDiagram.js").then((m) => ({ default: m.MermaidDiagram })));

/**
 * MessageBubble — ChatGPT-style thread entries (design.md §6 Messages).
 *
 * - user: right-aligned gray pill, no border
 * - assistant: plain text, no container, no accent rail
 * - both: an action row (copy / fork) that fades in under the message on hover
 */

function extractTextContent(message: ChatMessage): string {
  if (message.content && typeof message.content === "string") {
    // If there are content blocks with text, prefer those for richer content
    if (message.contentBlocks?.length) {
      const textParts = message.contentBlocks
        .filter((b): b is ContentBlock & { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text);
      if (textParts.length > 0) return textParts.join("\n\n");
    }
    return message.content;
  }
  if (message.contentBlocks?.length) {
    return message.contentBlocks
      .filter((b): b is ContentBlock & { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");
  }
  return "";
}

const actionBtn =
  "w-7 h-7 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors duration-120 cursor-pointer";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for insecure contexts
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!text) return null;

  return (
    <button
      onClick={handleCopy}
      className={actionBtn}
      title={copied ? "Copied!" : "Copy message"}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-success">
          <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 5.5v-2a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" />
        </svg>
      )}
    </button>
  );
}

function ForkButton({ onFork }: { onFork: () => void }) {
  return (
    <button onClick={onFork} className={actionBtn} title="Fork session from here">
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path fillRule="evenodd" d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.878A2.25 2.25 0 005.75 8.5h1.5v2.128a2.251 2.251 0 101.5 0V8.5h1.5a2.25 2.25 0 002.25-2.25v-.878a2.25 2.25 0 10-1.5 0v.878a.75.75 0 01-.75.75h-4.5A.75.75 0 015 6.25v-.878zm3.75 7.378a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm3-8.75a.75.75 0 100-1.5.75.75 0 000 1.5z" />
      </svg>
    </button>
  );
}

export function MessageBubble({ message, onFork }: { message: ChatMessage; onFork?: () => void }) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center py-1">
        <span className="text-[12px] text-cc-muted px-3 py-1 rounded-full bg-cc-hover">
          {message.content}
        </span>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="group/msg animate-[fadeSlideIn_0.15s_ease-out] flex flex-col items-end">
        <div className="max-w-[85%] sm:max-w-[70%] bg-cc-user-bubble rounded-3xl px-5 py-2.5">
          {message.images && message.images.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-2 mt-1">
              {message.images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.media_type};base64,${img.data}`}
                  alt="attachment"
                  className="max-w-[180px] sm:max-w-[240px] max-h-[140px] sm:max-h-[180px] rounded-xl object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
                />
              ))}
            </div>
          )}
          <pre className="text-[15px] whitespace-pre-wrap break-words font-sans-ui leading-[1.65] text-cc-fg">
            {message.content}
          </pre>
        </div>
        <div className="flex items-center gap-0.5 mt-1 mr-1 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity duration-120">
          {typeof message.content === "string" && message.content && (
            <CopyButton text={message.content} />
          )}
          {onFork && <ForkButton onFork={onFork} />}
        </div>
      </div>
    );
  }

  // Assistant message
  const textContent = extractTextContent(message);
  return (
    <div className="group/msg animate-[fadeSlideIn_0.15s_ease-out]">
      <AssistantMessage message={message} />
      {(textContent || onFork) && (
        <div className="flex items-center gap-0.5 mt-1.5 -ml-1.5 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity duration-120">
          {textContent && <CopyButton text={textContent} />}
          {onFork && <ForkButton onFork={onFork} />}
        </div>
      )}
    </div>
  );
}

interface ToolGroupItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type GroupedBlock =
  | { kind: "content"; block: ContentBlock }
  | { kind: "tool_group"; name: string; items: ToolGroupItem[] };

function groupContentBlocks(blocks: ContentBlock[]): GroupedBlock[] {
  const groups: GroupedBlock[] = [];

  for (const block of blocks) {
    if (block.type === "tool_use") {
      const last = groups[groups.length - 1];
      if (last?.kind === "tool_group" && last.name === block.name) {
        last.items.push({ id: block.id, name: block.name, input: block.input });
      } else {
        groups.push({
          kind: "tool_group",
          name: block.name,
          items: [{ id: block.id, name: block.name, input: block.input }],
        });
      }
    } else {
      groups.push({ kind: "content", block });
    }
  }

  return groups;
}

function AssistantMessage({ message }: { message: ChatMessage }) {
  const blocks = message.contentBlocks || [];

  const grouped = useMemo(() => groupContentBlocks(blocks), [blocks]);

  if (blocks.length === 0 && message.content) {
    return <MarkdownContent text={message.content} />;
  }

  return (
    <div className="space-y-2">
      {grouped.map((group, i) => {
        if (group.kind === "content") {
          return <ContentBlockRenderer key={i} block={group.block} />;
        }
        // Single tool_use renders as a step row
        if (group.items.length === 1) {
          const item = group.items[0];
          return <ToolBlock key={i} name={item.name} input={item.input} toolUseId={item.id} />;
        }
        // Grouped tool_uses
        return <ToolGroupBlock key={i} name={group.name} items={group.items} />;
      })}
    </div>
  );
}

function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="markdown-body text-[15px] text-cc-fg leading-[1.65] overflow-hidden text-pretty">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="mb-3 last:mb-0">{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-cc-fg">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="italic">{children}</em>
          ),
          h1: ({ children }) => (
            <h1 className="text-[20px] font-semibold text-cc-fg mt-5 mb-2 tracking-[-0.01em]">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-[17px] font-semibold text-cc-fg mt-4 mb-1.5 tracking-[-0.01em]">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-[15px] font-semibold text-cc-fg mt-3 mb-1">{children}</h3>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-6 mb-3 space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-6 mb-3 space-y-1">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="text-cc-fg leading-[1.6] marker:text-cc-muted">{children}</li>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-cc-link hover:underline underline-offset-2">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-cc-border pl-4 my-3 text-cc-muted">
              {children}
            </blockquote>
          ),
          hr: () => (
            <hr className="border-cc-border my-5" />
          ),
          code: (props: ComponentProps<"code">) => {
            const { children, className } = props;
            const match = /language-(\w+)/.exec(className || "");
            const isBlock = match || (typeof children === "string" && children.includes("\n"));

            if (isBlock) {
              const lang = match?.[1] || "";
              const codeStr = typeof children === "string" ? children : String(children ?? "");

              // Render mermaid diagrams
              if (lang === "mermaid") {
                return (
                  <Suspense fallback={
                    <div className="my-3 rounded-xl overflow-hidden border border-cc-border">
                      <div className="px-4 py-1.5 bg-cc-code-bg text-[12px] text-cc-code-fg/60">mermaid</div>
                      <div className="px-4 py-3 bg-cc-code-bg text-[12px] text-cc-muted animate-pulse">Loading diagram…</div>
                    </div>
                  }>
                    <MermaidDiagram code={codeStr} />
                  </Suspense>
                );
              }

              return (
                <div className="my-3 rounded-xl overflow-hidden bg-cc-code-bg border border-cc-border">
                  {lang && (
                    <div className="px-4 h-8 flex items-center text-[12px] text-cc-code-fg/60 border-b border-white/10">
                      {lang}
                    </div>
                  )}
                  <pre className="px-4 py-3 text-cc-code-fg text-[13px] font-mono-code leading-[1.6] overflow-x-auto">
                    <code>{children}</code>
                  </pre>
                </div>
              );
            }

            return (
              <code className="px-1.5 py-0.5 rounded-md bg-cc-hover text-[13.5px] font-mono-code text-cc-fg">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="overflow-x-auto my-3 rounded-xl border border-cc-border">
              <table className="min-w-full text-[13.5px] border-collapse">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-cc-hover">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 text-left text-[13px] font-semibold text-cc-fg border-b border-cc-border">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 text-[13.5px] text-cc-fg border-b border-cc-border/60 last:border-b-0">
              {children}
            </td>
          ),
          tr: ({ children }) => (
            <tr className="last:[&>td]:border-b-0">
              {children}
            </tr>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

function ContentBlockRenderer({ block }: { block: ContentBlock }) {
  if (block.type === "text") {
    return <MarkdownContent text={block.text} />;
  }

  if (block.type === "thinking") {
    return <ThinkingBlock text={block.thinking} />;
  }

  if (block.type === "tool_use") {
    return <ToolBlock name={block.name} input={block.input} toolUseId={block.id} />;
  }

  if (block.type === "tool_result") {
    const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    const isError = block.is_error;
    return (
      <div className={`text-[12px] font-mono-code rounded-xl px-3 py-2 ${
        isError
          ? "bg-cc-error/5 text-cc-error"
          : "bg-cc-hover text-cc-muted"
      } max-h-40 overflow-y-auto whitespace-pre-wrap`}>
        {content}
      </div>
    );
  }

  return null;
}

function ToolGroupBlock({ name, items }: { name: string; items: ToolGroupItem[] }) {
  const [open, setOpen] = useState(false);
  const iconType = getToolIcon(name);
  const label = getToolLabel(name);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="group/step flex items-center gap-2 -ml-2 pl-2 pr-3 h-8 rounded-lg text-left hover:bg-cc-hover transition-colors duration-120 cursor-pointer max-w-full"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`w-3 h-3 text-cc-muted transition-transform duration-150 shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <ToolIcon type={iconType} />
        <span className="text-[13px] font-medium text-cc-fg">
          {items.length}x {label}
        </span>
      </button>

      {open && (
        <div className="ml-5 pl-3 border-l border-cc-border mt-1 space-y-0.5">
          {items.map((item, i) => {
            const preview = getPreview(item.name, item.input);
            return (
              <div key={item.id || i} className="text-[12.5px] text-cc-muted font-mono-code truncate py-0.5">
                {preview || JSON.stringify(item.input).slice(0, 80)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 -ml-2 pl-2 pr-3 h-8 rounded-lg text-left hover:bg-cc-hover transition-colors duration-120 cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`w-3 h-3 text-cc-muted transition-transform duration-150 shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[13px] text-cc-muted">Reasoning</span>
        <span className="text-[12px] text-cc-muted/70 tabular-nums">{text.length}c</span>
      </button>
      <div
        className="overflow-hidden transition-[max-height] duration-200 ease-in-out"
        style={{ maxHeight: open ? "10rem" : "0" }}
      >
        <div className="overflow-y-auto max-h-40 ml-5 pl-3 border-l border-cc-border mt-1">
          <pre className="text-[13px] text-cc-muted font-sans-ui whitespace-pre-wrap leading-[1.6] py-1">
            {text}
          </pre>
        </div>
      </div>
    </div>
  );
}
