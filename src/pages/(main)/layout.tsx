import { Fragment, useEffect, useRef } from 'react'
import { Outlet, useParams } from 'react-router'

import { ScrollArea } from '~/components/ui/ScrollArea'
import { photoLoader } from '~/data/photos'
import { usePhotoViewer } from '~/hooks/usePhotoViewer'
import { MasonryRoot } from '~/modules/gallery/MasonryRoot'

export const Component = () => {
  const triggerOnceRef = useRef(false)

  const { openViewer } = usePhotoViewer()
  const { photoId } = useParams()
  useEffect(() => {
    if (triggerOnceRef.current) return
    triggerOnceRef.current = true

    if (photoId) {
      const photo = photoLoader
        .getPhotos()
        .find((photo) => photo.id === photoId)
      if (photo) {
        openViewer(photoLoader.getPhotos().indexOf(photo))
      }
    }
  }, [openViewer, photoId])

  return (
    <Fragment>
      <MasonryRoot />
      <ScrollArea rootClassName="h-screen w-full" viewportClassName="size-full">
        <div className="p-4">
          <Outlet />
        </div>
      </ScrollArea>
    </Fragment>
  )
}
