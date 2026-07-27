# Non-flake entry point: `nix-build` or `nix-env -f . -iA accountability-companion`.
{
  pkgs ? import <nixpkgs> { },
  port ? 7373,
}:

pkgs.callPackage ./nix/package.nix { inherit port; }
