import { type Component, createSignal, Show } from "solid-js";
import { useApp, type ViewId } from "../store/app";
import Menu from "./Menu";
import { useViewMenuItems } from "./Sidebar";

/**
 * A view's title. With the column on screen it is only the title; without it (column hidden, the
 * tablet band below 900, the phone) it is also the views menu: "Personal ⌄" lists every view with
 * Personal's count, so no count sits next to the title (design-taste WM2).
 */
const ViewTitle: Component<{
	title: string;
	/** The title opens the views menu. */
	asMenu: boolean;
	/** The view checked in the menu. */
	current: ViewId | null;
	/** The phone's large title (30px, as on the iPhone). */
	large?: boolean;
}> = (props) => {
	const [, actions] = useApp();
	const viewItems = useViewMenuItems();
	const [open, setOpen] = createSignal(false);
	let button: HTMLButtonElement | undefined;
	const heading = () => (
		<h1 class="mc-title" classList={{ "text-[30px] leading-tight": props.large }}>
			{props.title}
		</h1>
	);

	return (
		<Show when={props.asMenu} fallback={heading()}>
			<button
				ref={button}
				type="button"
				data-testid="view-title"
				aria-haspopup="menu"
				aria-expanded={open()}
				class="-ml-1.5 inline-flex items-center rounded-control px-1.5 py-0.5 hover:bg-raised"
				onClick={() => setOpen(!open())}
			>
				{heading()}
				<span class="mc-caret" aria-hidden="true" />
			</button>
			<Show when={open()}>
				<Menu
					label="Views"
					class="left-2 top-[52px]"
					anchor={() => button}
					onClose={() => setOpen(false)}
					sections={[
						{
							items: viewItems(),
							value: props.current,
							onPick: (v) => {
								setOpen(false);
								actions.setView(v as ViewId);
							},
						},
					]}
				/>
			</Show>
		</Show>
	);
};

export default ViewTitle;
