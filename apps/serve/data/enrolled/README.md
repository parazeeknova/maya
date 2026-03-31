# Maya Enrollment Directory

Create one folder per enrolled identity:

```text
enrolled/
  alice-chen/
    metadata.json
    ref-1.jpg
    ref-2.jpg
```

`metadata.json` should look like:

```json
{
  "name": "Alice Chen",
  "role": "Operator",
  "color": "#4ee3ff"
}
```

Any `jpg`, `jpeg`, `png`, or `webp` images in the folder are treated as reference images.
