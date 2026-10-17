import type { Request, Response } from 'express';
import type { CreateVenueInput, LayoutInput, UpdateVenueInput } from './venues.schemas';
import * as venuesService from './venues.service';

const id = (req: Request) => String(req.params.id);

export async function list(req: Request, res: Response): Promise<void> {
  res.json({ data: await venuesService.listVenues(req.user!) });
}

export async function create(req: Request, res: Response): Promise<void> {
  res.status(201).json(await venuesService.createVenue(req.user!, req.body as CreateVenueInput));
}

export async function get(req: Request, res: Response): Promise<void> {
  res.json(await venuesService.getVenue(req.user!, id(req)));
}

export async function update(req: Request, res: Response): Promise<void> {
  res.json(await venuesService.updateVenue(req.user!, id(req), req.body as UpdateVenueInput));
}

export async function remove(req: Request, res: Response): Promise<void> {
  await venuesService.deleteVenue(req.user!, id(req));
  res.status(204).end();
}

export async function listLayouts(req: Request, res: Response): Promise<void> {
  res.json({ data: await venuesService.listLayouts(req.user!, id(req)) });
}

export async function createLayout(req: Request, res: Response): Promise<void> {
  res
    .status(201)
    .json(await venuesService.createLayout(req.user!, id(req), req.body as LayoutInput));
}

export async function getLayout(req: Request, res: Response): Promise<void> {
  res.json(await venuesService.getLayout(req.user!, id(req)));
}

export async function replaceLayout(req: Request, res: Response): Promise<void> {
  res.json(await venuesService.replaceLayout(req.user!, id(req), req.body as LayoutInput));
}

export async function removeLayout(req: Request, res: Response): Promise<void> {
  await venuesService.deleteLayout(req.user!, id(req));
  res.status(204).end();
}
