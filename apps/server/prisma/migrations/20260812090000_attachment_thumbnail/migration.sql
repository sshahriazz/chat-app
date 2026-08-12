-- Poster image for an attachment, produced on the uploader's device.
--
-- Every viewer then renders a few kilobytes instead of the whole file: a 12 MP
-- photo shown in a 320px card cost 8 MB, and a video card downloaded the entire
-- clip just to find a frame to show.
--
-- All three columns are nullable and stay that way. Rows predating this
-- migration have no thumbnail, and a client that cannot produce one — an
-- unusual codec, a failed decode, an older build — must still be able to
-- upload the file.
ALTER TABLE "attachments"
  ADD COLUMN "thumbnail_key"    TEXT,
  ADD COLUMN "thumbnail_width"  INTEGER,
  ADD COLUMN "thumbnail_height" INTEGER;
