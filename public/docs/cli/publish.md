# kolm publish

Publish a `.kolm` artifact to the marketplace or a private registry.
The artifact must pass `kolm verify` before publish is allowed.

## Usage

```
kolm publish <artifact.kolm> # default registry
kolm publish <artifact.kolm> --registry <url> # private registry
kolm publish <artifact.kolm> --visibility public # marketplace listing
kolm publish <artifact.kolm> --visibility unlisted # private link
kolm publish <artifact.kolm> --tag <semver> # explicit version tag
```

## Pre-publish checks

1. `kolm verify` must succeed on the artifact.
2. The actor key must hold `publish` scope for the target namespace.
3. The frozen-eval K-score must meet the gate declared in the recipe.
4. The license file must declare a non-empty license id.

## After publish

The registry returns a content-addressed URL. Anyone with the URL can
`kolm install <url>` if the visibility allows it. The publish action
itself is signed and appended to the receipt chain.

## See also

- `kolm verify` for the pre-publish 7-check audit.
- `kolm team` for managing publisher roles.
- `/marketplace` to browse public recipes.
