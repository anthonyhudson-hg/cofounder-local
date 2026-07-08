import { Gender, shuffledSillyNames } from "./sillyNames";

export interface Candidate {
  name: string;
  gender: Gender;
  photoUrl: string;
}

interface RandomUserResult {
  picture: { large: string };
}

const FETCH_TIMEOUT_MS = 10_000;

async function fetchPhotos(gender: Gender, count: number): Promise<string[]> {
  if (count === 0) return [];

  // No timeout previously — a hung request blocked candidate generation
  // indefinitely with no recovery path (report §5.9).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`https://randomuser.me/api/?results=${count}&gender=${gender}&inc=picture&noinfo`, {
      signal: controller.signal,
    });
  } catch (err) {
    // Reuses the caught error object (message amended) rather than constructing a new
    // one, so the original error/stack is preserved without needing the ES2022
    // `Error(message, {cause})` overload this project's ES2020 target lacks.
    if (controller.signal.aborted && err instanceof Error) {
      err.message = `randomuser.me request timed out: ${err.message}`;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`randomuser.me request failed: ${res.status}`);
  const data = (await res.json()) as { results: RandomUserResult[] };
  if (data.results.length !== count) {
    // A short response previously silently produced `photoUrl: undefined` for the
    // excess candidates despite the type claiming `string`, surfacing later as a
    // confusing downstream fetch error instead of a clear message here — which
    // HireModal.tsx can now also offer a Retry button for (report §5.9).
    throw new Error(`randomuser.me returned ${data.results.length} results, expected ${count}`);
  }
  return data.results.map((r) => r.picture.large);
}

export async function fetchCandidates(count: number): Promise<Candidate[]> {
  const names = shuffledSillyNames().slice(0, count);
  const maleCount = names.filter((n) => n.gender === "male").length;
  const femaleCount = names.length - maleCount;

  const [malePhotos, femalePhotos] = await Promise.all([
    fetchPhotos("male", maleCount),
    fetchPhotos("female", femaleCount),
  ]);

  let mi = 0;
  let fi = 0;
  return names.map((n) => ({
    name: n.name,
    gender: n.gender,
    photoUrl: n.gender === "male" ? malePhotos[mi++] : femalePhotos[fi++],
  }));
}
