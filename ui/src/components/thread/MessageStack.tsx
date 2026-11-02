import type { Component } from "solid-js";
import type { Email } from "../../types";
import { messageTime, monthDay, type People } from "../../utils/thread-text";

interface MessageStackProps {
	/** "earlier": the split-off earlier conversation; "middle": this thread's middle messages. */
	stack: "earlier" | "middle";
	emails: Email[];
	people: People;
	onOpen: () => void;
}

/** A folded run of messages: count, who wrote, when. Opens in place. */
const MessageStack: Component<MessageStackProps> = (props) => {
	const names = () => [...new Set(props.emails.map((e) => props.people.sender(e)))].join(", ");
	const range = () => {
		const first = monthDay(messageTime(props.emails[0]));
		const last = monthDay(messageTime(props.emails[props.emails.length - 1]));
		return first === last ? first : `${first} – ${last}`;
	};
	const label = () =>
		`Show ${props.emails.length} ${props.stack === "earlier" ? "earlier" : "more"} messages from ${names()}, ${range()}`;
	return (
		<button
			type="button"
			data-testid="message-stack"
			data-stack={props.stack}
			data-count={props.emails.length}
			aria-label={label()}
			class="mc-stack mb-1.5 w-full flex items-center gap-3 px-4 py-2.5 text-left border border-solid border-border rounded-box bg-sheet hover:border-control"
			onClick={() => props.onOpen()}
		>
			<span class="shrink-0 min-w-6 h-6 px-1.5 grid place-items-center border border-control rounded-full font-semibold text-[0.85em]">
				{props.emails.length}
			</span>
			<span class="min-w-0 truncate text-muted">{names()}</span>
			<span class="ml-auto shrink-0 whitespace-nowrap text-muted text-[0.88em]">{range()}</span>
		</button>
	);
};

export default MessageStack;
