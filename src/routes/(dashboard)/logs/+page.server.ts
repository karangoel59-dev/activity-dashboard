import { getEntries } from '$lib/server/flow';
import type { PageServerLoad } from './$types';

// Read on every visit: entries are plain files, so new writing shows up on reload
export const load: PageServerLoad = () => getEntries();
