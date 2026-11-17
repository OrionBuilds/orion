import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { parseMentions, type MentionTargetType } from '../../utils/mentionTokens';

const ROUTE_BY_TYPE: Partial<Record<MentionTargetType, string>> = {
  contact: '/contacts',
  opportunity: '/opportunities',
  project: '/projects',
  proposal: '/proposals',
  // 'document' routes land with A4; 'user' has no detail route today.
};

interface MentionTextProps {
  text: string;
  className?: string;
}

/**
 * Renders free text containing `@[Display Name](type:id)` tokens, turning
 * each token into a styled `Link` to the mentioned entity's detail page
 * (when a route exists) or a plain styled span otherwise. Plain text
 * outside of tokens is rendered as-is (React escapes it automatically).
 */
export function MentionText({ text, className }: MentionTextProps) {
  if (!text) return null;

  const mentions = parseMentions(text);
  if (mentions.length === 0) {
    return <span className={className}>{text}</span>;
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;

  mentions.forEach((m, i) => {
    if (m.index > cursor) {
      nodes.push(
        <Fragment key={`t-${i}`}>{text.slice(cursor, m.index)}</Fragment>
      );
    }

    const route = ROUTE_BY_TYPE[m.type];
    if (route) {
      nodes.push(
        <Link
          key={`m-${i}`}
          to={`${route}/${m.id}`}
          className="text-hud-gold-soft hover:text-hud-gold-soft font-medium hover:underline"
        >
          @{m.displayName}
        </Link>
      );
    } else {
      nodes.push(
        <span key={`m-${i}`} className="text-hud-gold-soft font-medium">
          @{m.displayName}
        </span>
      );
    }

    cursor = m.index + m.raw.length;
  });

  if (cursor < text.length) {
    nodes.push(<Fragment key="t-end">{text.slice(cursor)}</Fragment>);
  }

  return <span className={className}>{nodes}</span>;
}
