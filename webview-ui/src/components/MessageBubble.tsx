import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";

export function UserBubble({ text }: { text: string }) {
  return (
    <Message align="end">
      <MessageContent>
        <Bubble variant="secondary" align="end">
          <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

/** Markdown with the safety rules: no raw HTML, images as text, only http(s)/mailto links. */
export function Md({ text }: { text: string }) {
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
      >
        {text}
      </Markdown>
    </div>
  );
}

export function AssistantText({ text }: { text: string }) {
  return (
    <Message>
      <MessageContent>
        <Bubble variant="ghost">
          <BubbleContent>
            <Md text={text} />
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
