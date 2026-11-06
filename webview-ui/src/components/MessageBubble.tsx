import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[90%] whitespace-pre-wrap break-words rounded-lg bg-secondary px-2.5 py-1.5 text-secondary-foreground">
        {text}
      </div>
    </div>
  );
}

export function AssistantText({ text }: { text: string }) {
  return (
    <div className="markdown min-w-0">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Never load images: a remote URL could exfiltrate data.
          // Only http(s)/mailto links are clickable; VS Code opens them externally.
          a: ({ href, children }) =>
            href && /^(https?:|mailto:)/i.test(href) ? (
              <a href={href} rel="noreferrer noopener">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt, src }) => <span className="opacity-70">[image: {alt || src}]</span>,
        }}
      >{text}</Markdown>
    </div>
  );
}
