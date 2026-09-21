// Category pills: a soft tint of the hue with readable text in both themes
const HUES = ['pink', 'indigo', 'teal', 'orange', 'cyan', 'green', 'emerald', 'rose'] as const;

// Written out in full so Tailwind can see every class
const PILLS: Record<string, string> = {
	pink: 'bg-pink-500/12 text-pink-700 dark:text-pink-300',
	indigo: 'bg-indigo-500/12 text-indigo-700 dark:text-indigo-300',
	teal: 'bg-teal-500/12 text-teal-700 dark:text-teal-300',
	orange: 'bg-orange-500/12 text-orange-700 dark:text-orange-300',
	cyan: 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-300',
	green: 'bg-green-500/12 text-green-700 dark:text-green-300',
	emerald: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
	rose: 'bg-rose-500/12 text-rose-700 dark:text-rose-300'
};

const DOTS: Record<string, string> = {
	pink: 'bg-pink-500',
	indigo: 'bg-indigo-500',
	teal: 'bg-teal-500',
	orange: 'bg-orange-500',
	cyan: 'bg-cyan-500',
	green: 'bg-green-500',
	emerald: 'bg-emerald-500',
	rose: 'bg-rose-500'
};

function hash(text: string): number {
	let h = 0;
	for (let i = 0; i < text.length; i++) h = text.charCodeAt(i) + ((h << 5) - h);
	return Math.abs(h);
}

/** A stable colour for a name (repo, tag, …): the same name always gets the same pill. */
export function getPillColor(name: string) {
	if (!name) return 'bg-raised text-ink-2';
	return PILLS[HUES[hash(name.toLowerCase().trim()) % HUES.length]];
}

/** The solid colour behind a name's pill, for small dots that identify it. */
export function getDotColor(name: string) {
	return DOTS[HUES[hash(name.toLowerCase().trim()) % HUES.length]] ?? 'bg-ink-3';
}

export const formatDate = (dateStr: string) => {
	if (!dateStr) return '';
	const date = new Date(dateStr);
	if (isNaN(date.getTime())) return dateStr;
	return new Intl.DateTimeFormat('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	}).format(date);
};
