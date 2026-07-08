import { Gender, shuffledSillyNames } from "./sillyNames";

export interface Candidate {
  name: string;
  gender: Gender;
  photoUrl: string;
}

interface RandomUserResult {
  picture: { large: string };
}

async function fetchPhotos(gender: Gender, count: number): Promise<string[]> {
  if (count === 0) return [];
  const res = await fetch(`https://randomuser.me/api/?results=${count}&gender=${gender}&inc=picture&noinfo`);
  if (!res.ok) throw new Error(`randomuser.me request failed: ${res.status}`);
  const data = (await res.json()) as { results: RandomUserResult[] };
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
