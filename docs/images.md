# Use Images in Livemark

## Insert

- Paste an image, or drag one into the document.
- **Format → Image → Insert Image…** picks one file, **Insert Local Images…** picks several.
- Type `![description](path-or-url)`.
- **Format → Take Picture** imports a photo from an iPhone or iPad nearby.

## Where images go

**Settings → Image → When Insert** decides what happens to a newly inserted picture:

| Option | Result |
| :-- | :-- |
| No special action | The picture stays where it is and the document points at it |
| Copy image to current folder | Copied next to the document |
| Copy image to ./assets | Copied to an `assets` folder next to the document |
| Copy image to ./${filename}.assets | A folder named after the document |
| Copy image to custom folder | Any relative or absolute folder |
| Upload image | Uploaded with the configured uploader; the document gets the URL |

The same page chooses whether the rule applies to local and to online images, whether paths are relative, and whether to prefer `<img>` tags.

## Per document

Two keys in the YAML front matter override the settings for one document:

```yaml
---
typora-copy-images-to: ./media
typora-root-url: /Users/me/site
---
```

`typora-copy-images-to` may also be `upload`. `typora-root-url` is the folder image paths are resolved against. Both can be set from **Format → Image**.

## Working with an image

Put the caret in an image, then use **Format → Image** to zoom it, switch between Markdown and HTML syntax, copy its content, copy, rename or move the file, or delete the file.

**Move All Images to…** and **Copy All Images to…** gather every local picture of the document into one folder.

## Uploading

Choose an uploader in **Settings → Image → Image Upload Setting**: PicGo.app, PicList, uPic, PicGo-Core, or a command of your own. A custom command receives the image paths as arguments and prints one URL per image. **Test Uploader** uploads a sample and shows the output.

## TextBundle

A document saved as `.textbundle` keeps its pictures inside the bundle, in `assets/`.
