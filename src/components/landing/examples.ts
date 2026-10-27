// Portfolio on the landing page. Add an entry per finished example: the original video's
// link, the photo that was used, and the result (files live in public/brand/examples/).
export type Example = {
  title: string;
  original: string; // link to the source video
  originalThumb: string;
  photo: string; // the reference photo that went in
  result: string; // the finished render
  poster: string;
};

export const EXAMPLES: Example[] = [
  {
    title: "Music video, every shot of the lead rapper",
    original: "https://www.youtube.com/watch?v=74TFS8r_SMI",
    originalThumb: "/brand/examples/original-1.jpg",
    photo: "/brand/examples/photo-1.jpg",
    result: "/brand/example.mp4",
    poster: "/brand/example.jpg",
  },
];
